import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { ConcurrencyConflictError } from '../../application/errors';
import {
  InboxRepository,
  LedgerRepository,
  OutboxRepository,
  WagerTransactionRepository,
  WalletRepository,
} from '../../application/ports/repositories';
import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import {
  applyOutboxState,
  applyTransactionState,
  inboxToDomain,
  inboxToRecord,
  ledgerEntryToDomain,
  ledgerEntryToRecord,
  outboxToDomain,
  outboxToRecord,
  transactionToDomain,
  transactionToRecord,
  walletToDomain,
  walletToRecord,
} from './mappers';
import {
  InboxMessageRecord,
  LedgerEntryRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletRecord,
} from './records';

/**
 * Repositórios ligados ao EntityManager de UMA transação (criados pelo UnitOfWork).
 * Inserts são acumulados no Unit of Work do MikroORM e enviados no flush do commit.
 */

export class MikroOrmWalletRepository implements WalletRepository {
  /** versão lida do banco por wallet — base do UPDATE condicionado */
  private readonly loadedVersions = new Map<string, number>();

  constructor(private readonly entityManager: EntityManager) {}

  async findById(walletId: string): Promise<Wallet | null> {
    const record = await this.entityManager.findOne(WalletRecord, { id: walletId }, { refresh: true });
    return record ? this.track(record) : null;
  }

  async findByIdForUpdate(walletId: string): Promise<Wallet | null> {
    const record = await this.entityManager.findOne(
      WalletRecord,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? this.track(record) : null;
  }

  async findByIdForShare(walletId: string): Promise<Wallet | null> {
    const record = await this.entityManager.findOne(
      WalletRecord,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_READ, refresh: true },
    );
    return record ? this.track(record) : null;
  }

  add(wallet: Wallet): void {
    this.entityManager.persist(walletToRecord(wallet));
    this.loadedVersions.set(wallet.id, wallet.version);
  }

  async save(wallet: Wallet): Promise<void> {
    const expectedVersion = this.loadedVersions.get(wallet.id);
    if (expectedVersion === undefined) {
      throw new Error(`wallet ${wallet.id} não foi carregada nesta transação`);
    }
    if (expectedVersion === wallet.version) return;

    const affectedRows = await this.entityManager.nativeUpdate(
      WalletRecord,
      { id: wallet.id, version: expectedVersion },
      { balance: wallet.balance.toAmountString(), version: wallet.version, updatedAt: wallet.updatedAt },
    );
    if (affectedRows !== 1) {
      throw new ConcurrencyConflictError(wallet.id);
    }
    this.loadedVersions.set(wallet.id, wallet.version);
  }

  private track(record: WalletRecord): Wallet {
    this.loadedVersions.set(record.id, record.version);
    return walletToDomain(record);
  }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  private readonly records = new Map<string, WagerTransactionRecord>();

  constructor(private readonly entityManager: EntityManager) {}

  async findById(transactionId: string): Promise<WagerTransaction | null> {
    return this.findOne({ id: transactionId });
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null> {
    return this.findOne({ providerId, idempotencyKey });
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    return this.findOne({ providerId, externalTransactionId });
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const reversalCount = await this.entityManager.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return reversalCount > 0;
  }

  add(transaction: WagerTransaction, metadata: { correlationId: string }): void {
    const record = transactionToRecord(transaction, metadata.correlationId);
    this.entityManager.persist(record);
    this.records.set(transaction.id, record);
  }

  save(transaction: WagerTransaction): void {
    const record = this.records.get(transaction.id);
    if (!record) {
      throw new Error(`transação ${transaction.id} não foi carregada nesta transação`);
    }
    applyTransactionState(record, transaction);
  }

  correlationIdOf(transactionId: string): string | undefined {
    return this.records.get(transactionId)?.correlationId;
  }

  async findDuePendingReferences(now: Date, limit: number): Promise<Array<{ transactionId: string; walletId: string }>> {
    const dueRecords = await this.entityManager.find(
      WagerTransactionRecord,
      { status: WagerTransactionStatus.PendingReference, nextReferenceResolutionAt: { $lte: now } },
      { orderBy: { nextReferenceResolutionAt: 'asc' }, limit },
    );
    return dueRecords.map((record) => ({ transactionId: record.id, walletId: record.walletId }));
  }

  async wakeDependents(walletId: string, providerId: string, externalTransactionId: string, now: Date): Promise<void> {
    await this.entityManager.nativeUpdate(
      WagerTransactionRecord,
      {
        walletId,
        providerId,
        referenceExternalTransactionId: externalTransactionId,
        status: WagerTransactionStatus.PendingReference,
      },
      { nextReferenceResolutionAt: now },
    );
  }

  private async findOne(filter: Partial<WagerTransactionRecord>): Promise<WagerTransaction | null> {
    const record = await this.entityManager.findOne(WagerTransactionRecord, filter, { refresh: true });
    if (!record) return null;
    this.records.set(record.id, record);
    return transactionToDomain(record);
  }
}

export class MikroOrmLedgerRepository implements LedgerRepository {
  constructor(private readonly entityManager: EntityManager) {}

  add(entry: WalletLedgerEntry): void {
    this.entityManager.persist(ledgerEntryToRecord(entry));
  }

  async findPage(walletId: string, afterWalletVersion: number | undefined, limit: number): Promise<WalletLedgerEntry[]> {
    const records = await this.entityManager.find(
      LedgerEntryRecord,
      { walletId, walletVersion: { $gt: afterWalletVersion ?? 0 } },
      { orderBy: { walletVersion: 'asc' }, limit },
    );
    return records.map(ledgerEntryToDomain);
  }

  /** Soma com sinal feita no banco, em numeric — sem passar por number. */
  async summarize(walletId: string, currency: string): Promise<{ calculatedBalance: Money; entryCount: number }> {
    const [summaryRow] = await this.entityManager.execute<Array<{ signed_total: string; entry_count: number }>>(
      `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::text AS signed_total,
              COUNT(*)::int AS entry_count
         FROM wallet_ledger_entries
        WHERE wallet_id = ?`,
      [walletId],
    );
    return {
      calculatedBalance: Money.rehydrate(summaryRow?.signed_total ?? '0', currency),
      entryCount: summaryRow?.entry_count ?? 0,
    };
  }
}

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly entityManager: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const record = await this.entityManager.findOne(InboxMessageRecord, { consumerName, messageId }, { refresh: true });
    return record ? inboxToDomain(record) : null;
  }

  add(message: InboxMessage): void {
    this.entityManager.persist(inboxToRecord(message));
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  private readonly records = new Map<string, OutboxMessageRecord>();

  constructor(private readonly entityManager: EntityManager) {}

  add(message: OutboxMessage): void {
    const record = outboxToRecord(message);
    this.entityManager.persist(record);
    this.records.set(message.id, record);
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const dueRecords = await this.entityManager.find(
      OutboxMessageRecord,
      { publishedAt: null, nextAttemptAt: { $lte: now } },
      { orderBy: { occurredAt: 'asc' }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE, refresh: true },
    );
    for (const record of dueRecords) {
      this.records.set(record.id, record);
    }
    return dueRecords.map(outboxToDomain);
  }

  save(message: OutboxMessage): void {
    const record = this.records.get(message.id);
    if (!record) {
      throw new Error(`mensagem de outbox ${message.id} não foi carregada nesta transação`);
    }
    applyOutboxState(record, message);
  }

  async oldestPendingOccurredAt(): Promise<Date | undefined> {
    const [oldestRow] = await this.entityManager.execute<Array<{ oldest: Date | null }>>(
      'SELECT MIN(occurred_at) AS oldest FROM outbox_messages WHERE published_at IS NULL',
    );
    return oldestRow?.oldest ? new Date(oldestRow.oldest) : undefined;
  }
}
