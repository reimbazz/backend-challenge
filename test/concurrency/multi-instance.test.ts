import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateId } from '../../src/domain/shared/identifiers';
import { postJson, RunningInstance, startInstances, stopInstances } from '../support/app-instances';
import { createTestOrm } from '../support/test-database';

/**
 * ≥ 3 processos independentes da aplicação disputando as mesmas wallets via HTTP.
 * Não há nenhum estado compartilhado entre eles além do PostgreSQL.
 */

let instances: RunningInstance[];

beforeAll(async () => {
  const migrationOrm = await createTestOrm();
  await migrationOrm.close(true);
  instances = await startInstances(3, 3201);
}, 60_000);

afterAll(async () => {
  await stopInstances(instances);
});

/** Distribui requisições entre as instâncias em round-robin. */
function instanceFor(requestIndex: number): string {
  return instances[requestIndex % instances.length]!.baseUrl;
}

async function createWallet(initialAmount: string) {
  const playerId = generateId();
  const { status, body } = await postJson(`${instanceFor(0)}/wallets`, {
    playerId,
    initialBalance: { amount: initialAmount, currency: 'BRL' },
  });
  expect(status).toBe(201);
  return { walletId: body.id as string, playerId };
}

function betBody(wallet: { walletId: string; playerId: string }, externalTransactionId: string, amount: string) {
  return {
    providerId: 'provider-a',
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

function submitBet(requestIndex: number, wallet: { walletId: string; playerId: string }, externalTransactionId: string, amount: string) {
  return postJson(`${instanceFor(requestIndex)}/wagering/transactions`, betBody(wallet, externalTransactionId, amount), {
    'Idempotency-Key': `provider-a:${externalTransactionId}`,
  });
}

async function reconcile(walletId: string) {
  const { body } = await postJson(`${instanceFor(1)}/wallets/${walletId}/reconciliation`, {});
  return body;
}

describe('3 instâncias simultâneas', () => {
  test('a mesma aposta enviada 60 vezes, espalhada nas 3 instâncias, debita uma única vez', async () => {
    const wallet = await createWallet('100.00');
    const externalTransactionId = `ext-${generateId()}`;

    const responses = await Promise.all(
      Array.from({ length: 60 }, (_, requestIndex) => submitBet(requestIndex, wallet, externalTransactionId, '25.00')),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(responses.filter((response) => response.body.idempotentReplay === false)).toHaveLength(1);
    expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);

    const reconciliation = await reconcile(wallet.walletId);
    expect(reconciliation).toMatchObject({ consistent: true, storedBalance: { amount: '75.00' }, checkedEntries: 2 });
  });

  test('cenário 100 / 80 / 80 com cada aposta em uma instância diferente', async () => {
    const wallet = await createWallet('100.00');

    const responses = await Promise.all([
      submitBet(0, wallet, `ext-${generateId()}`, '80.00'),
      submitBet(1, wallet, `ext-${generateId()}`, '80.00'),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
    expect(responses.find((response) => response.status === 422)?.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await reconcile(wallet.walletId)).toMatchObject({
      consistent: true,
      storedBalance: { amount: '20.00' },
      checkedEntries: 2,
    });
  });

  test('hot wallet: 45 apostas distintas de 10 sobre saldo 100 nas 3 instâncias → exatamente 10 aceitas', async () => {
    const wallet = await createWallet('100.00');

    const responses = await Promise.all(
      Array.from({ length: 45 }, (_, requestIndex) => submitBet(requestIndex, wallet, `ext-${generateId()}`, '10.00')),
    );

    expect(responses.filter((response) => response.status === 200)).toHaveLength(10);
    expect(responses.filter((response) => response.status === 422)).toHaveLength(35);
    expect(await reconcile(wallet.walletId)).toMatchObject({ consistent: true, storedBalance: { amount: '0.00' } });
  });

  test('wallets distintas em paralelo nas 3 instâncias', async () => {
    const wallets = await Promise.all(Array.from({ length: 12 }, () => createWallet('30.00')));

    await Promise.all(
      wallets.flatMap((wallet, walletIndex) =>
        Array.from({ length: 4 }, (_, betIndex) => submitBet(walletIndex + betIndex, wallet, `ext-${generateId()}`, '10.00')),
      ),
    );

    for (const wallet of wallets) {
      expect(await reconcile(wallet.walletId)).toMatchObject({ consistent: true, storedBalance: { amount: '0.00' } });
    }
  });
});
