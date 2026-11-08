import { EntitySchema } from '@mikro-orm/core';

/**
 * Modelos de persistência (um por tabela), separados do domínio: o domínio não conhece
 * MikroORM e a conversão fica nos mappers. Mapeados via EntitySchema (sem decorators).
 * `numeric` é hidratado como string — nunca passa por number.
 */

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletRecordSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string' },
    currency: { type: 'string' },
    balance: { type: 'decimal', precision: 19, scale: 2 },
    version: { type: 'integer' },
    createdAt: { type: 'datetime' },
    updatedAt: { type: 'datetime' },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  resultingBalance?: string | null;
  referenceResolutionAttempts!: number;
  nextReferenceResolutionAt?: Date | null;
  correlationId!: string;
  createdAt!: Date;
  processedAt?: Date | null;
}

export const WagerTransactionRecordSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string' },
    externalTransactionId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    payloadHash: { type: 'string' },
    walletId: { type: 'uuid' },
    playerId: { type: 'string' },
    roundId: { type: 'string' },
    gameId: { type: 'string' },
    kind: { type: 'string' },
    amount: { type: 'decimal', precision: 19, scale: 2 },
    currency: { type: 'string' },
    referenceExternalTransactionId: { type: 'string', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    status: { type: 'string' },
    failureCode: { type: 'string', nullable: true },
    resultingBalance: { type: 'decimal', precision: 19, scale: 2, nullable: true },
    referenceResolutionAttempts: { type: 'integer' },
    nextReferenceResolutionAt: { type: 'datetime', nullable: true },
    correlationId: { type: 'string' },
    createdAt: { type: 'datetime' },
    processedAt: { type: 'datetime', nullable: true },
  },
});

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  walletVersion!: number;
  direction!: string;
  amount!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  currency!: string;
  createdAt!: Date;
}

export const LedgerEntryRecordSchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    walletVersion: { type: 'integer' },
    direction: { type: 'string' },
    amount: { type: 'decimal', precision: 19, scale: 2 },
    balanceBefore: { type: 'decimal', precision: 19, scale: 2 },
    balanceAfter: { type: 'decimal', precision: 19, scale: 2 },
    currency: { type: 'string' },
    createdAt: { type: 'datetime' },
  },
});

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxMessageRecordSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', primary: true },
    messageId: { type: 'string', primary: true },
    payloadHash: { type: 'string' },
    receivedAt: { type: 'datetime' },
    processedAt: { type: 'datetime', nullable: true },
  },
});

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
  lastError?: string | null;
}

export const OutboxMessageRecordSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string' },
    eventType: { type: 'string' },
    payload: { type: 'json' },
    occurredAt: { type: 'datetime' },
    attempts: { type: 'integer' },
    nextAttemptAt: { type: 'datetime', nullable: true },
    publishedAt: { type: 'datetime', nullable: true },
    lastError: { type: 'text', nullable: true },
  },
});

export const ALL_RECORD_SCHEMAS = [
  WalletRecordSchema,
  WagerTransactionRecordSchema,
  LedgerEntryRecordSchema,
  InboxMessageRecordSchema,
  OutboxMessageRecordSchema,
];
