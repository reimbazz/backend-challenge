import { LedgerDirection, WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import { FailureCode } from '../../domain/wagering/failure-code';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records';

/** Conversões record ⇄ domínio. Money é sempre (numeric como string) + currency. */

export function walletToDomain(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: Money.rehydrate(record.balance, record.currency),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

export function walletToRecord(wallet: Wallet): WalletRecord {
  return Object.assign(new WalletRecord(), {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toAmountString(),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  });
}

export function transactionToDomain(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: Money.rehydrate(record.amount, record.currency),
    referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    referenceTransactionId: record.referenceTransactionId ?? undefined,
    failureCode: (record.failureCode as FailureCode | null) ?? undefined,
    processedAt: record.processedAt ?? undefined,
    resultingBalance: record.resultingBalance ? Money.rehydrate(record.resultingBalance, record.currency) : undefined,
    referenceResolutionAttempts: record.referenceResolutionAttempts,
    nextReferenceResolutionAt: record.nextReferenceResolutionAt ?? undefined,
  });
}

export function transactionToRecord(transaction: WagerTransaction, correlationId: string): WagerTransactionRecord {
  const record = Object.assign(new WagerTransactionRecord(), {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: transaction.money.toAmountString(),
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    correlationId,
    createdAt: transaction.createdAt,
  });
  applyTransactionState(record, transaction);
  return record;
}

/** Copia apenas o estado mutável (resultado do processamento) para o record. */
export function applyTransactionState(record: WagerTransactionRecord, transaction: WagerTransaction): void {
  record.status = transaction.status;
  record.referenceTransactionId = transaction.referenceTransactionId ?? null;
  record.failureCode = transaction.failureCode ?? null;
  record.resultingBalance = transaction.resultingBalance?.toAmountString() ?? null;
  record.referenceResolutionAttempts = transaction.referenceResolutionAttempts;
  record.nextReferenceResolutionAt = transaction.nextReferenceResolutionAt ?? null;
  record.processedAt = transaction.processedAt ?? null;
}

export function ledgerEntryToDomain(record: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: record.id,
    walletId: record.walletId,
    transactionId: record.transactionId,
    walletVersion: record.walletVersion,
    direction: record.direction as LedgerDirection,
    money: Money.rehydrate(record.amount, record.currency),
    balanceBefore: Money.rehydrate(record.balanceBefore, record.currency),
    balanceAfter: Money.rehydrate(record.balanceAfter, record.currency),
    createdAt: record.createdAt,
  });
}

export function ledgerEntryToRecord(entry: WalletLedgerEntry): LedgerEntryRecord {
  return Object.assign(new LedgerEntryRecord(), {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    walletVersion: entry.walletVersion,
    direction: entry.direction,
    amount: entry.money.toAmountString(),
    balanceBefore: entry.balanceBefore.toAmountString(),
    balanceAfter: entry.balanceAfter.toAmountString(),
    currency: entry.money.currency,
    createdAt: entry.createdAt,
  });
}

export function inboxToDomain(record: InboxMessageRecord): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: record.consumerName,
    messageId: record.messageId,
    payloadHash: record.payloadHash,
    receivedAt: record.receivedAt,
    processedAt: record.processedAt ?? undefined,
  });
}

export function inboxToRecord(message: InboxMessage): InboxMessageRecord {
  return Object.assign(new InboxMessageRecord(), {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt ?? null,
  });
}

export function outboxToDomain(record: OutboxMessageRecord): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: record.id,
    aggregateId: record.aggregateId,
    eventType: record.eventType,
    payload: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
    nextAttemptAt: record.nextAttemptAt ?? undefined,
    publishedAt: record.publishedAt ?? undefined,
    lastError: record.lastError ?? undefined,
  });
}

export function outboxToRecord(message: OutboxMessage): OutboxMessageRecord {
  const record = Object.assign(new OutboxMessageRecord(), {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
  });
  applyOutboxState(record, message);
  return record;
}

export function applyOutboxState(record: OutboxMessageRecord, message: OutboxMessage): void {
  record.attempts = message.attempts;
  record.nextAttemptAt = message.nextAttemptAt ?? null;
  record.publishedAt = message.publishedAt ?? null;
  record.lastError = message.lastError ?? null;
}
