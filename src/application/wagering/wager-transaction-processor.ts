import { EventContext } from '../../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/wagering-events';
import { LedgerDirection } from '../../domain/ledger/wallet-ledger-entry';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { FailureCode } from '../../domain/wagering/failure-code';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { TransactionalContext } from '../ports/repositories';

/**
 * Aplica uma transação PENDING/PENDING_REFERENCE sobre a wallet já travada (FOR UPDATE).
 * Usado pela entrada (HTTP/SQS) e pelo worker de referências pendentes.
 *
 * Tudo acontece no mesmo TransactionalContext: transação, saldo, ledger e outbox
 * são confirmados juntos ou nada é.
 */
export class WagerTransactionProcessor {
  /**
   * @param wallet wallet travada, ou null se não existir
   * @returns a transação já no novo estado (PROCESSED, REJECTED ou PENDING_REFERENCE)
   */
  async apply(
    context: TransactionalContext,
    transaction: WagerTransaction,
    wallet: Wallet | null,
    now: Date,
    eventContext: EventContext,
  ): Promise<WagerTransaction> {
    const rejectionCode = this.validateWallet(transaction, wallet);
    if (rejectionCode || !wallet) {
      return this.reject(context, transaction, rejectionCode ?? FailureCode.WalletNotFound, wallet, now, eventContext);
    }

    let reference: WagerTransaction | undefined;

    if (transaction.hasReference()) {
      const foundReference = await context.transactions.findByExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId!,
      );

      if (!foundReference) {
        return this.waitForReference(context, transaction, wallet, now, eventContext);
      }

      const referenceCheck = transaction.checkReference(foundReference);
      if (referenceCheck.outcome === 'WAIT') {
        return this.waitForReference(context, transaction, wallet, now, eventContext);
      }
      if (referenceCheck.outcome === 'INCOMPATIBLE') {
        return this.reject(context, transaction, referenceCheck.failureCode, wallet, now, eventContext);
      }
      if (transaction.isReversal() && (await context.transactions.hasProcessedReversal(foundReference.id))) {
        return this.reject(context, transaction, FailureCode.ReferenceAlreadyReversed, wallet, now, eventContext);
      }

      reference = foundReference;
    }

    if (!transaction.affectsBalance()) {
      transaction.markProcessed(reference?.id, wallet.balance, now);
      return this.finalizeProcessed(context, transaction, now, eventContext);
    }

    const direction = transaction.ledgerDirectionFor(reference);

    if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
      // Regra 9: falta de saldo numa reversão é operacionalmente diferente de aposta sem saldo.
      const insufficientFundsCode =
        transaction.kind === WagerTransactionKind.Bet
          ? FailureCode.InsufficientFunds
          : FailureCode.ReversalInsufficientFunds;
      return this.reject(context, transaction, insufficientFundsCode, wallet, now, eventContext);
    }

    const ledgerEntry =
      direction === LedgerDirection.Debit
        ? wallet.debit(transaction.money, transaction.id, now)
        : wallet.credit(transaction.money, transaction.id, now);

    context.ledger.add(ledgerEntry);
    await context.wallets.save(wallet);
    transaction.markProcessed(reference?.id, wallet.balance, now);
    context.outbox.add(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, ledgerEntry, eventContext)));

    return this.finalizeProcessed(context, transaction, now, eventContext);
  }

  /** @returns failureCode se a wallet não puder receber a transação */
  private validateWallet(transaction: WagerTransaction, wallet: Wallet | null): FailureCode | undefined {
    if (!wallet) return FailureCode.WalletNotFound;
    if (wallet.playerId !== transaction.playerId) return FailureCode.WalletPlayerMismatch;
    if (wallet.currency !== transaction.money.currency) return FailureCode.CurrencyMismatch;
    return undefined;
  }

  private async finalizeProcessed(
    context: TransactionalContext,
    transaction: WagerTransaction,
    now: Date,
    eventContext: EventContext,
  ): Promise<WagerTransaction> {
    context.transactions.save(transaction);
    context.outbox.add(OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, eventContext)));
    await context.transactions.wakeDependents(
      transaction.walletId,
      transaction.providerId,
      transaction.externalTransactionId,
      now,
    );
    return transaction;
  }

  private reject(
    context: TransactionalContext,
    transaction: WagerTransaction,
    failureCode: FailureCode,
    wallet: Wallet | null,
    now: Date,
    eventContext: EventContext,
  ): WagerTransaction {
    transaction.reject(failureCode, wallet?.balance, now);
    context.transactions.save(transaction);
    context.outbox.add(OutboxMessage.enqueue(WagerTransactionRejected.from(transaction, eventContext)));
    return transaction;
  }

  /** Referência ausente: agenda nova tentativa ou, esgotado o limite, rejeita com REFERENCE_NOT_FOUND. */
  private waitForReference(
    context: TransactionalContext,
    transaction: WagerTransaction,
    wallet: Wallet,
    now: Date,
    eventContext: EventContext,
  ): WagerTransaction {
    if (transaction.hasExhaustedReferenceResolution()) {
      return this.reject(context, transaction, FailureCode.ReferenceNotFound, wallet, now, eventContext);
    }

    const isFirstTimePending = transaction.status !== WagerTransactionStatus.PendingReference;
    transaction.markPendingReference(now);
    context.transactions.save(transaction);

    if (isFirstTimePending) {
      context.outbox.add(OutboxMessage.enqueue(WagerTransactionPendingReference.from(transaction, eventContext)));
    }
    return transaction;
  }
}
