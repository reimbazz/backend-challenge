import { z } from 'zod';
import { WalletBalanceChanged } from '../../domain/events/wagering-events';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money, MoneyProps } from '../../domain/money/money';
import { DomainError } from '../../domain/shared/domain-error';
import { generateId } from '../../domain/shared/identifiers';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { InvalidRequestError, NotFoundError, UniqueConstraintConflictError, WalletAlreadyExistsError } from '../errors';
import { Clock, StructuredLogger, WageringMetrics } from '../ports/observability';
import { UnitOfWork } from '../ports/repositories';

export const createWalletSchema = z.object({
  playerId: z.string().min(1).max(128),
  initialBalance: z.object({ amount: z.string(), currency: z.string() }).strict(),
});

export interface WalletView {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export interface LedgerEntryView {
  id: string;
  transactionId: string;
  walletVersion: number;
  direction: string;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPageView {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export function toWalletView(wallet: Wallet): WalletView {
  return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
}

/** Criação de wallet: wallet, OPENING e lançamento CREDIT na mesma transação SQL. */
export class CreateWalletUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  /**
   * @throws InvalidRequestError payload ou Money inválidos
   * @throws WalletAlreadyExistsError já existe wallet para player + moeda
   */
  async execute(request: unknown, correlationId: string): Promise<WalletView> {
    const parsed = createWalletSchema.safeParse(request);
    if (!parsed.success) {
      throw new InvalidRequestError('payload inválido', parsed.error.flatten());
    }

    let initialBalance: Money;
    try {
      initialBalance = Money.from(parsed.data.initialBalance);
    } catch (error) {
      throw error instanceof DomainError ? new InvalidRequestError(error.message, { code: error.code }) : error;
    }

    const now = this.clock.now();
    const walletId = generateId();
    const openingTransactionId = generateId();
    const { wallet, openingLedgerEntry } = Wallet.open({
      id: walletId,
      playerId: parsed.data.playerId,
      initialBalance,
      openingTransactionId,
      openedAt: now,
    });

    try {
      await this.unitOfWork.run(async (context) => {
        context.wallets.add(wallet);
        if (openingLedgerEntry) {
          const openingTransaction = WagerTransaction.createOpening({
            id: openingTransactionId,
            walletId,
            playerId: wallet.playerId,
            initialBalance,
            createdAt: now,
          });
          context.transactions.add(openingTransaction, { correlationId });
          context.ledger.add(openingLedgerEntry);
          context.outbox.add(
            OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingLedgerEntry, { correlationId, occurredAt: now })),
          );
        }
      });
    } catch (error) {
      if (error instanceof UniqueConstraintConflictError && error.constraintName === 'wallets_player_currency_unique') {
        throw new WalletAlreadyExistsError(wallet.playerId, wallet.currency);
      }
      throw error;
    }

    return toWalletView(wallet);
  }
}

/** Consultas de wallet: saldo, ledger paginado e reconciliação. */
export class WalletQueries {
  static readonly MAX_PAGE_SIZE = 200;

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly metrics: WageringMetrics,
    private readonly logger: StructuredLogger,
  ) {}

  /** @throws NotFoundError */
  async getWallet(walletId: string): Promise<WalletView> {
    assertUuid(walletId);
    const wallet = await this.unitOfWork.run((context) => context.wallets.findById(walletId));
    if (!wallet) throw new NotFoundError('wallet', walletId);
    return toWalletView(wallet);
  }

  /**
   * Cursor opaco = base64url da última wallet_version entregue. Estável porque a versão
   * é única por wallet e o ledger é append-only.
   * @throws NotFoundError | InvalidRequestError (cursor/limit inválidos)
   */
  async getLedgerPage(walletId: string, cursor: string | undefined, limit: number): Promise<LedgerPageView> {
    assertUuid(walletId);
    if (!Number.isInteger(limit) || limit < 1 || limit > WalletQueries.MAX_PAGE_SIZE) {
      throw new InvalidRequestError(`limit deve estar entre 1 e ${WalletQueries.MAX_PAGE_SIZE}`);
    }
    const afterWalletVersion = cursor === undefined ? undefined : decodeLedgerCursor(cursor);

    const { wallet, entries } = await this.unitOfWork.run(async (context) => ({
      wallet: await context.wallets.findById(walletId),
      entries: await context.ledger.findPage(walletId, afterWalletVersion, limit + 1),
    }));
    if (!wallet) throw new NotFoundError('wallet', walletId);

    const hasMore = entries.length > limit;
    const pageEntries = entries.slice(0, limit);
    const lastEntry = pageEntries.at(-1);

    return {
      items: pageEntries.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        walletVersion: entry.walletVersion,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: hasMore && lastEntry ? encodeLedgerCursor(lastEntry.walletVersion) : null,
    };
  }

  /**
   * Compara saldo materializado com a soma do ledger. Wallet lida com FOR SHARE: nenhuma
   * escrita intercala entre as duas leituras. Divergência é logada e contada, nunca corrigida.
   * @throws NotFoundError
   */
  async reconcile(walletId: string, correlationId: string): Promise<ReconciliationView> {
    assertUuid(walletId);
    const reconciliation = await this.unitOfWork.run(async (context) => {
      const wallet = await context.wallets.findByIdForShare(walletId);
      if (!wallet) return undefined;
      const summary = await context.ledger.summarize(walletId, wallet.currency);
      return { wallet, summary };
    });
    if (!reconciliation) throw new NotFoundError('wallet', walletId);

    const { wallet, summary } = reconciliation;
    const difference = wallet.balance.subtract(summary.calculatedBalance);
    const consistent = difference.isZero();

    if (!consistent) {
      this.metrics.reconciliationMismatch();
      this.logger.error(
        { correlationId, walletId, difference: difference.toAmountString(), checkedEntries: summary.entryCount },
        'divergência entre saldo e ledger',
      );
    }

    return {
      walletId,
      storedBalance: wallet.balance.toJSON(),
      calculatedBalance: summary.calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: summary.entryCount,
    };
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(identifier: string): void {
  if (!UUID_PATTERN.test(identifier)) {
    throw new InvalidRequestError(`identificador inválido: ${identifier}`);
  }
}

function encodeLedgerCursor(walletVersion: number): string {
  return Buffer.from(JSON.stringify({ v: walletVersion })).toString('base64url');
}

function decodeLedgerCursor(cursor: string): number {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown };
    if (typeof decoded.v === 'number' && Number.isInteger(decoded.v) && decoded.v >= 0) {
      return decoded.v;
    }
  } catch {
    // cai no erro abaixo
  }
  throw new InvalidRequestError('cursor inválido');
}
