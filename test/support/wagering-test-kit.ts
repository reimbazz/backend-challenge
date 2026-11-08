import { MikroORM } from '@mikro-orm/postgresql';
import { expect } from 'bun:test';
import { Clock, StructuredLogger } from '../../src/application/ports/observability';
import { ResolvePendingReferencesUseCase } from '../../src/application/wagering/resolve-pending-references';
import { SubmitWagerTransactionUseCase, WagerRequest } from '../../src/application/wagering/submit-wager-transaction';
import { WagerTransactionProcessor } from '../../src/application/wagering/wager-transaction-processor';
import { WagerTransactionQueries } from '../../src/application/wagering/wager-transaction-queries';
import { CreateWalletUseCase, WalletQueries } from '../../src/application/wallets/wallet-use-cases';
import { generateId } from '../../src/domain/shared/identifiers';
import { PrometheusWageringMetrics } from '../../src/infrastructure/observability/prometheus-metrics';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { createTestOrm } from './test-database';

export const silentLogger: StructuredLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Relógio controlável: permite avançar o tempo para o worker de referências pendentes. */
export class TestClock implements Clock {
  private currentTime = Date.now();

  now(): Date {
    return new Date(this.currentTime);
  }

  advanceBy(milliseconds: number): void {
    this.currentTime += milliseconds;
  }
}

/** Monta os use cases reais sobre o Postgres real — nada de mocks de persistência. */
export async function createWageringTestKit() {
  const orm: MikroORM = await createTestOrm();
  const clock = new TestClock();
  const metrics = new PrometheusWageringMetrics();
  const unitOfWork = new MikroOrmUnitOfWork(orm, metrics);
  const processor = new WagerTransactionProcessor();

  return {
    orm,
    clock,
    metrics,
    unitOfWork,
    createWallet: new CreateWalletUseCase(unitOfWork, clock),
    submitWager: new SubmitWagerTransactionUseCase(unitOfWork, processor, clock, metrics, silentLogger),
    resolvePendingReferences: new ResolvePendingReferencesUseCase(unitOfWork, processor, clock, metrics, silentLogger),
    walletQueries: new WalletQueries(unitOfWork, metrics, silentLogger),
    transactionQueries: new WagerTransactionQueries(unitOfWork),
  };
}

export type WageringTestKit = Awaited<ReturnType<typeof createWageringTestKit>>;

/** Abre uma wallet BRL para um player novo. */
export async function openWallet(kit: WageringTestKit, initialAmount = '100.00') {
  const playerId = generateId();
  const wallet = await kit.createWallet.execute(
    { playerId, initialBalance: { amount: initialAmount, currency: 'BRL' } },
    'test',
  );
  return { walletId: wallet.id, playerId };
}

/** Monta um pedido com externalTransactionId único por padrão. */
export function wagerRequest(
  wallet: { walletId: string; playerId: string },
  overrides: Omit<Partial<WagerRequest>, 'kind'> & { kind: `${WagerRequest['kind']}`; amount?: string },
): WagerRequest {
  const { amount, kind, ...requestOverrides } = overrides;
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${generateId()}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: kind as WagerRequest['kind'],
    money: { amount: amount ?? '10.00', currency: 'BRL' },
    ...requestOverrides,
  };
}

/** Submete pelo use case com a idempotency key padrão "{providerId}:{externalTransactionId}". */
export function submit(kit: WageringTestKit, request: WagerRequest, inboxMessageId?: string) {
  return kit.submitWager.execute({
    idempotencyKey: `${request.providerId}:${request.externalTransactionId}`,
    request,
    correlationId: generateId(),
    source: inboxMessageId ? 'sqs' : 'http',
    ...(inboxMessageId ? { inboxMessage: { consumerName: 'wager-transactions-consumer', messageId: inboxMessageId } } : {}),
  });
}

/** Invariante final de todos os testes: saldo materializado == saldo reconstruído pelo ledger. */
export async function expectWalletMatchesLedger(kit: WageringTestKit, walletId: string, expectedAmount?: string) {
  const reconciliation = await kit.walletQueries.reconcile(walletId, 'test');
  expect(reconciliation.consistent).toBe(true);
  expect(reconciliation.storedBalance).toEqual(reconciliation.calculatedBalance);
  if (expectedAmount !== undefined) {
    expect(reconciliation.storedBalance.amount).toBe(expectedAmount);
  }
  return reconciliation;
}

/** Conta linhas da wallet numa tabela, direto no banco. */
export async function countRows(kit: WageringTestKit, table: 'wallet_ledger_entries' | 'wager_transactions', walletId: string, extraFilter: Record<string, unknown> = {}) {
  const [row] = await kit.orm.em.getKnex()(table).where({ wallet_id: walletId, ...extraFilter }).count<{ count: string }[]>('* as count');
  return Number(row?.count ?? 0);
}
