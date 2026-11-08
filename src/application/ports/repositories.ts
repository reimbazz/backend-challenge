import { WalletLedgerEntry } from '../../domain/ledger/wallet-ledger-entry';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { Money } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';

export interface WalletRepository {
  findById(walletId: string): Promise<Wallet | null>;
  /** SELECT ... FOR UPDATE na linha da wallet — serializa operações da mesma wallet entre instâncias. */
  findByIdForUpdate(walletId: string): Promise<Wallet | null>;
  /** SELECT ... FOR SHARE — leitura consistente sem bloquear outros leitores. */
  findByIdForShare(walletId: string): Promise<Wallet | null>;
  add(wallet: Wallet): void;
  /**
   * UPDATE condicionado à versão carregada (defesa extra além do lock).
   * @throws ConcurrencyConflictError se a versão no banco mudou
   */
  save(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
  findById(transactionId: string): Promise<WagerTransaction | null>;
  findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | null>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null>;
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  add(transaction: WagerTransaction, metadata: { correlationId: string }): void;
  save(transaction: WagerTransaction): void;
  /** correlationId original da transação carregada (para eventos gerados pelo worker). */
  correlationIdOf(transactionId: string): string | undefined;
  findDuePendingReferences(now: Date, limit: number): Promise<Array<{ transactionId: string; walletId: string }>>;
  /** Antecipa a próxima tentativa das transações da mesma wallet que aguardam esta referência. */
  wakeDependents(walletId: string, providerId: string, externalTransactionId: string, now: Date): Promise<void>;
}

export interface LedgerRepository {
  add(entry: WalletLedgerEntry): void;
  /** Página ordenada por wallet_version (cursor estável). */
  findPage(walletId: string, afterWalletVersion: number | undefined, limit: number): Promise<WalletLedgerEntry[]>;
  summarize(walletId: string, currency: string): Promise<{ calculatedBalance: Money; entryCount: number }>;
}

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | null>;
  add(message: InboxMessage): void;
}

export interface OutboxRepository {
  add(message: OutboxMessage): void;
  /** SELECT ... FOR UPDATE SKIP LOCKED — publishers concorrentes nunca pegam a mesma linha. */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  save(message: OutboxMessage): void;
  oldestPendingOccurredAt(): Promise<Date | undefined>;
}

/** Repositórios ligados a uma única transação SQL. */
export interface TransactionalContext {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export interface UnitOfWork {
  /**
   * Executa `work` numa transação SQL: commit se resolver, rollback se lançar.
   * Erros de persistência são traduzidos para os erros de aplicação (ver application/errors).
   */
  run<T>(work: (context: TransactionalContext) => Promise<T>): Promise<T>;
}
