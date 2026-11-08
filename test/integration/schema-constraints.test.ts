import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Knex } from '@mikro-orm/postgresql';
import { MikroORM } from '@mikro-orm/postgresql';
import { generateId } from '../../src/domain/shared/identifiers';
import { createTestOrm } from '../support/test-database';

/**
 * Prova que as invariantes da seção 6 são aplicadas pelo schema, escrevendo SQL direto
 * (sem passar pelo domínio). Cada cenário roda numa transação; os triggers deferred
 * disparam no COMMIT.
 */

let orm: MikroORM;
let knex: Knex;

beforeAll(async () => {
  orm = await createTestOrm();
  knex = orm.em.getKnex();
});

afterAll(async () => {
  await orm.close(true);
});

const now = new Date();

/** O query builder do knex é thenable, não Promise; o Bun exige Promise em `.rejects`. */
function rejects(operation: PromiseLike<unknown>) {
  return expect(Promise.resolve(operation)).rejects;
}

/** Insere wallet + OPENING + lançamento de abertura, consistente. Retorna os ids. */
async function insertWalletWithOpening(trx: Knex, initialBalance = '100.00') {
  const walletId = generateId();
  const openingTransactionId = generateId();
  const playerId = generateId();

  await trx('wallets').insert({
    id: walletId,
    player_id: playerId,
    currency: 'BRL',
    balance: initialBalance,
    version: 1,
    created_at: now,
    updated_at: now,
  });
  await trx('wager_transactions').insert(
    transactionRow({ id: openingTransactionId, walletId, playerId, kind: 'OPENING', amount: initialBalance }),
  );
  await trx('wallet_ledger_entries').insert({
    id: generateId(),
    wallet_id: walletId,
    transaction_id: openingTransactionId,
    wallet_version: 1,
    direction: 'CREDIT',
    amount: initialBalance,
    balance_before: '0.00',
    balance_after: initialBalance,
    currency: 'BRL',
    created_at: now,
  });

  return { walletId, playerId, openingTransactionId };
}

/** Linha de wager_transactions com defaults; status PROCESSED por padrão. */
function transactionRow(props: {
  id: string;
  walletId: string;
  playerId: string;
  kind: string;
  amount: string;
  status?: string;
  failureCode?: string;
  referenceTransactionId?: string;
  referenceExternalTransactionId?: string;
}) {
  const status = props.status ?? 'PROCESSED';
  return {
    id: props.id,
    provider_id: 'provider-a',
    external_transaction_id: `ext-${props.id}`,
    idempotency_key: `provider-a:ext-${props.id}`,
    payload_hash: 'hash',
    wallet_id: props.walletId,
    player_id: props.playerId,
    round_id: 'round-1',
    game_id: 'game-1',
    kind: props.kind,
    amount: props.amount,
    currency: 'BRL',
    reference_external_transaction_id: props.referenceExternalTransactionId ?? null,
    reference_transaction_id: props.referenceTransactionId ?? null,
    status,
    failure_code: props.failureCode ?? null,
    correlation_id: 'test',
    created_at: now,
    processed_at: ['PROCESSED', 'REJECTED', 'FAILED'].includes(status) ? now : null,
  };
}

/** Aplica um débito consistente (wallet + transação + lançamento). */
async function insertProcessedBet(trx: Knex, walletId: string, playerId: string, amount: string, balanceBefore: string, version: number) {
  const betId = generateId();
  const balanceAfter = (Number(balanceBefore) - Number(amount)).toFixed(2); // só para montar o fixture
  await trx('wager_transactions').insert(transactionRow({ id: betId, walletId, playerId, kind: 'BET', amount }));
  await trx('wallet_ledger_entries').insert({
    id: generateId(),
    wallet_id: walletId,
    transaction_id: betId,
    wallet_version: version,
    direction: 'DEBIT',
    amount,
    balance_before: balanceBefore,
    balance_after: balanceAfter,
    currency: 'BRL',
    created_at: now,
  });
  await trx('wallets').where({ id: walletId }).update({ balance: balanceAfter, version });
  return betId;
}

describe('schema — wallets', () => {
  test('cenário válido é aceito (sanidade dos fixtures)', async () => {
    await knex.transaction(async (trx) => {
      const { walletId, playerId } = await insertWalletWithOpening(trx);
      await insertProcessedBet(trx, walletId, playerId, '30.00', '100.00', 2);
    });
  });

  test('no máximo uma wallet por player + moeda', async () => {
    const playerId = generateId();
    const walletRow = (id: string) => ({
      id, player_id: playerId, currency: 'BRL', balance: '0.00', version: 1, created_at: now, updated_at: now,
    });
    await knex('wallets').insert(walletRow(generateId()));
    await rejects(knex('wallets').insert(walletRow(generateId()))).toThrow(/wallets_player_currency_unique/);
  });

  test('saldo negativo é recusado', async () => {
    await rejects(
      knex('wallets').insert({
        id: generateId(), player_id: generateId(), currency: 'BRL', balance: '-0.01', version: 1, created_at: now, updated_at: now,
      }),
    ).toThrow(/check constraint/);
  });

  test('alterar saldo sem lançamento no ledger falha no commit', async () => {
    const { walletId } = await knex.transaction((trx) => insertWalletWithOpening(trx));
    await rejects(
      knex.transaction(async (trx) => {
        await trx('wallets').where({ id: walletId }).update({ balance: '50.00', version: 2 });
      }),
    ).toThrow(/diverges from ledger/);
  });

  test('wallet com saldo inicial sem lançamento de abertura falha no commit', async () => {
    await rejects(
      knex('wallets').insert({
        id: generateId(), player_id: generateId(), currency: 'BRL', balance: '10.00', version: 1, created_at: now, updated_at: now,
      }),
    ).toThrow(/balance without ledger entries/);
  });
});

describe('schema — ledger', () => {
  test('UPDATE, DELETE e TRUNCATE são bloqueados', async () => {
    const { walletId } = await knex.transaction((trx) => insertWalletWithOpening(trx));

    await rejects(knex('wallet_ledger_entries').where({ wallet_id: walletId }).update({ amount: '1.00' })).toThrow(/append-only/);
    await rejects(knex('wallet_ledger_entries').where({ wallet_id: walletId }).delete()).toThrow(/append-only/);
    await rejects(knex.raw('TRUNCATE wallet_ledger_entries CASCADE')).toThrow(/append-only/);
  });

  test('aritmética errada (before - amount ≠ after) é recusada', async () => {
    await rejects(
      knex.transaction(async (trx) => {
        const { walletId, playerId } = await insertWalletWithOpening(trx);
        const betId = generateId();
        await trx('wager_transactions').insert(transactionRow({ id: betId, walletId, playerId, kind: 'BET', amount: '10.00' }));
        await trx('wallet_ledger_entries').insert({
          id: generateId(), wallet_id: walletId, transaction_id: betId, wallet_version: 2, direction: 'DEBIT',
          amount: '10.00', balance_before: '100.00', balance_after: '95.00', currency: 'BRL', created_at: now,
        });
      }),
    ).toThrow(/ledger_arithmetic/);
  });

  test('encadeamento quebrado (balance_before ≠ último balance_after) é recusado', async () => {
    await rejects(
      knex.transaction(async (trx) => {
        const { walletId, playerId } = await insertWalletWithOpening(trx);
        const betId = generateId();
        await trx('wager_transactions').insert(transactionRow({ id: betId, walletId, playerId, kind: 'BET', amount: '10.00' }));
        await trx('wallet_ledger_entries').insert({
          id: generateId(), wallet_id: walletId, transaction_id: betId, wallet_version: 2, direction: 'DEBIT',
          amount: '10.00', balance_before: '500.00', balance_after: '490.00', currency: 'BRL', created_at: now,
        });
      }),
    ).toThrow(/ledger chain broken/);
  });

  test('dois lançamentos para a mesma transação e wallet são recusados', async () => {
    await rejects(
      knex.transaction(async (trx) => {
        const { walletId, playerId } = await insertWalletWithOpening(trx);
        const betId = await insertProcessedBet(trx, walletId, playerId, '10.00', '100.00', 2);
        await trx('wallet_ledger_entries').insert({
          id: generateId(), wallet_id: walletId, transaction_id: betId, wallet_version: 3, direction: 'DEBIT',
          amount: '10.00', balance_before: '90.00', balance_after: '80.00', currency: 'BRL', created_at: now,
        });
      }),
    ).toThrow(/ledger_one_entry_per_transaction_wallet/);
  });
});

describe('schema — wager_transactions', () => {
  test('mesma idempotency key do mesmo provider é recusada', async () => {
    const { walletId, playerId } = await knex.transaction((trx) => insertWalletWithOpening(trx));
    const lossRow = transactionRow({ id: generateId(), walletId, playerId, kind: 'LOSS', amount: '0.00' });
    await knex('wager_transactions').insert(lossRow);

    await rejects(
      knex('wager_transactions').insert({ ...lossRow, id: generateId(), external_transaction_id: 'other' }),
    ).toThrow(/wager_tx_provider_idempotency_unique/);
  });

  test('BET PROCESSED sem lançamento falha no commit', async () => {
    const { walletId, playerId } = await knex.transaction((trx) => insertWalletWithOpening(trx));
    await rejects(
      knex('wager_transactions').insert(transactionRow({ id: generateId(), walletId, playerId, kind: 'BET', amount: '5.00' })),
    ).toThrow(/inconsistent with ledger/);
  });

  test('transação REJECTED com lançamento falha no commit', async () => {
    await rejects(
      knex.transaction(async (trx) => {
        const { walletId, playerId } = await insertWalletWithOpening(trx);
        const betId = await insertProcessedBet(trx, walletId, playerId, '10.00', '100.00', 2);
        void betId;
        const rejectedId = generateId();
        await trx('wager_transactions').insert(
          transactionRow({ id: rejectedId, walletId, playerId, kind: 'WIN', amount: '10.00', status: 'REJECTED', failureCode: 'X' }),
        );
        await trx('wallet_ledger_entries').insert({
          id: generateId(), wallet_id: walletId, transaction_id: rejectedId, wallet_version: 3, direction: 'CREDIT',
          amount: '10.00', balance_before: '90.00', balance_after: '100.00', currency: 'BRL', created_at: now,
        });
        await trx('wallets').where({ id: walletId }).update({ balance: '100.00', version: 3 });
      }),
    ).toThrow(/inconsistent with ledger/);
  });

  test('status terminal não pode ser alterado', async () => {
    const { openingTransactionId } = await knex.transaction((trx) => insertWalletWithOpening(trx));
    await rejects(
      knex('wager_transactions').where({ id: openingTransactionId }).update({ status: 'REJECTED', failure_code: 'X' }),
    ).toThrow(/is terminal/);
  });

  test('REFUND sem referência é recusado', async () => {
    const { walletId, playerId } = await knex.transaction((trx) => insertWalletWithOpening(trx));
    await rejects(
      knex('wager_transactions').insert(
        transactionRow({ id: generateId(), walletId, playerId, kind: 'REFUND', amount: '1.00', status: 'REJECTED', failureCode: 'X' }),
      ),
    ).toThrow(/wager_tx_reversal_requires_reference/);
  });

  test('a mesma referência não pode ser revertida duas vezes', async () => {
    await rejects(
      knex.transaction(async (trx) => {
        const { walletId, playerId } = await insertWalletWithOpening(trx);
        const betId = await insertProcessedBet(trx, walletId, playerId, '10.00', '100.00', 2);

        let currentBalance = 90;
        for (const [version, reversalKind] of [[3, 'REFUND'], [4, 'ROLLBACK']] as const) {
          const reversalId = generateId();
          await trx('wager_transactions').insert(
            transactionRow({
              id: reversalId, walletId, playerId, kind: reversalKind, amount: '10.00',
              referenceTransactionId: betId, referenceExternalTransactionId: `ext-${betId}`,
            }),
          );
          await trx('wallet_ledger_entries').insert({
            id: generateId(), wallet_id: walletId, transaction_id: reversalId, wallet_version: version, direction: 'CREDIT',
            amount: '10.00', balance_before: currentBalance.toFixed(2), balance_after: (currentBalance + 10).toFixed(2),
            currency: 'BRL', created_at: now,
          });
          currentBalance += 10;
          await trx('wallets').where({ id: walletId }).update({ balance: currentBalance.toFixed(2), version });
        }
      }),
    ).toThrow(/wager_tx_single_reversal_per_reference/);
  });
});

describe('schema — inbox', () => {
  test('a mesma mensagem não é registrada duas vezes pelo mesmo consumidor', async () => {
    const inboxRow = { consumer_name: 'wager-consumer', message_id: generateId(), payload_hash: 'h', received_at: now };
    await knex('inbox_messages').insert(inboxRow);
    await rejects(knex('inbox_messages').insert(inboxRow)).toThrow(/duplicate key/);
  });
});
