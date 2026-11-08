import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { IdempotencyConflictError, WalletAlreadyExistsError } from '../../src/application/errors';
import { generateId } from '../../src/domain/shared/identifiers';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction';
import {
  countRows,
  createWageringTestKit,
  expectWalletMatchesLedger,
  openWallet,
  submit,
  wagerRequest,
  WageringTestKit,
} from '../support/wagering-test-kit';

let kit: WageringTestKit;

beforeAll(async () => {
  kit = await createWageringTestKit();
});

afterAll(async () => {
  await kit.orm.close(true);
});

describe('criação de wallet', () => {
  test('saldo inicial gera OPENING + CREDIT na mesma transação', async () => {
    const wallet = await openWallet(kit, '1000.00');
    const view = await kit.walletQueries.getWallet(wallet.walletId);

    expect(view.balance).toEqual({ amount: '1000.00', currency: 'BRL' });
    expect(view.version).toBe(1);
    expect(await countRows(kit, 'wager_transactions', wallet.walletId, { kind: 'OPENING' })).toBe(1);
    await expectWalletMatchesLedger(kit, wallet.walletId, '1000.00');
  });

  test('wallet duplicada para player + moeda é conflito', async () => {
    const playerId = generateId();
    const request = { playerId, initialBalance: { amount: '0.00', currency: 'BRL' } };
    await kit.createWallet.execute(request, 'test');
    await expect(kit.createWallet.execute(request, 'test')).rejects.toBeInstanceOf(WalletAlreadyExistsError);
  });
});

describe('regras por tipo de operação', () => {
  test('BET debita, WIN credita, LOSS não move saldo nem versão', async () => {
    const wallet = await openWallet(kit, '100.00');

    const bet = await submit(kit, wagerRequest(wallet, { kind: 'BET', amount: '25.00' }));
    expect(bet).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false });

    const win = await submit(kit, wagerRequest(wallet, { kind: 'WIN', amount: '40.00' }));
    expect(win.balance?.amount).toBe('115.00');

    const loss = await submit(kit, wagerRequest(wallet, { kind: 'LOSS', amount: '0.00' }));
    expect(loss).toMatchObject({ status: 'PROCESSED', balance: { amount: '115.00' } });

    expect((await kit.walletQueries.getWallet(wallet.walletId)).version).toBe(3);
    expect(await countRows(kit, 'wallet_ledger_entries', wallet.walletId)).toBe(3);
    await expectWalletMatchesLedger(kit, wallet.walletId, '115.00');
  });

  test('BET sem saldo é REJECTED com INSUFFICIENT_FUNDS e não gera ledger', async () => {
    const wallet = await openWallet(kit, '10.00');
    const bet = await submit(kit, wagerRequest(wallet, { kind: 'BET', amount: '10.01' }));

    expect(bet).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '10.00' } });
    expect(await countRows(kit, 'wallet_ledger_entries', wallet.walletId)).toBe(1);
    await expectWalletMatchesLedger(kit, wallet.walletId, '10.00');
  });

  test('moeda diferente da wallet é REJECTED com CURRENCY_MISMATCH', async () => {
    const wallet = await openWallet(kit, '10.00');
    const bet = await submit(kit, { ...wagerRequest(wallet, { kind: 'BET' }), money: { amount: '1.00', currency: 'USD' } });
    expect(bet).toMatchObject({ status: 'REJECTED', failureCode: 'CURRENCY_MISMATCH' });
  });

  test('wallet inexistente e wallet de outro player são rejeitadas', async () => {
    const wallet = await openWallet(kit, '10.00');

    const unknownWallet = await submit(kit, wagerRequest({ ...wallet, walletId: generateId() }, { kind: 'BET' }));
    expect(unknownWallet).toMatchObject({ status: 'REJECTED', failureCode: 'WALLET_NOT_FOUND' });

    const otherPlayer = await submit(kit, wagerRequest({ ...wallet, playerId: generateId() }, { kind: 'BET' }));
    expect(otherPlayer).toMatchObject({ status: 'REJECTED', failureCode: 'WALLET_PLAYER_MISMATCH' });
  });

  test('REFUND reverte a BET uma única vez; ROLLBACK posterior da mesma BET é recusado', async () => {
    const wallet = await openWallet(kit, '100.00');
    const betRequest = wagerRequest(wallet, { kind: 'BET', amount: '30.00' });
    await submit(kit, betRequest);

    const refundRequest = wagerRequest(wallet, {
      kind: 'REFUND',
      amount: '30.00',
      referenceExternalTransactionId: betRequest.externalTransactionId,
    });
    expect(await submit(kit, refundRequest)).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });

    const secondRefund = await submit(kit, { ...refundRequest, externalTransactionId: `ext-${generateId()}` });
    expect(secondRefund).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_REVERSED' });

    const rollback = await submit(kit, { ...refundRequest, kind: WagerTransactionKind.Rollback, externalTransactionId: `ext-${generateId()}` });
    expect(rollback).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_ALREADY_REVERSED' });

    await expectWalletMatchesLedger(kit, wallet.walletId, '100.00');
  });

  test('REFUND com valor diferente, de outra rodada ou referenciando WIN é rejeitado', async () => {
    const wallet = await openWallet(kit, '100.00');
    const betRequest = wagerRequest(wallet, { kind: 'BET', amount: '30.00' });
    const winRequest = wagerRequest(wallet, { kind: 'WIN', amount: '5.00' });
    await submit(kit, betRequest);
    await submit(kit, winRequest);

    const reference = { referenceExternalTransactionId: betRequest.externalTransactionId };
    expect(await submit(kit, wagerRequest(wallet, { kind: 'REFUND', amount: '10.00', ...reference }))).toMatchObject({
      failureCode: 'REVERSAL_AMOUNT_MISMATCH',
    });
    expect(await submit(kit, wagerRequest(wallet, { kind: 'REFUND', amount: '30.00', roundId: 'outra', ...reference }))).toMatchObject({
      failureCode: 'REFERENCE_MISMATCH',
    });
    expect(
      await submit(kit, wagerRequest(wallet, { kind: 'REFUND', amount: '5.00', referenceExternalTransactionId: winRequest.externalTransactionId })),
    ).toMatchObject({ failureCode: 'INVALID_REFERENCE_KIND' });
  });

  test('ROLLBACK de WIN debita; sem saldo é REVERSAL_INSUFFICIENT_FUNDS (≠ INSUFFICIENT_FUNDS)', async () => {
    const wallet = await openWallet(kit, '0.00');
    const winRequest = wagerRequest(wallet, { kind: 'WIN', amount: '50.00' });
    await submit(kit, winRequest);
    await submit(kit, wagerRequest(wallet, { kind: 'BET', amount: '45.00' }));

    const rollback = await submit(
      kit,
      wagerRequest(wallet, { kind: 'ROLLBACK', amount: '50.00', referenceExternalTransactionId: winRequest.externalTransactionId }),
    );
    expect(rollback).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_INSUFFICIENT_FUNDS', balance: { amount: '5.00' } });
    await expectWalletMatchesLedger(kit, wallet.walletId, '5.00');
  });

  test('ROLLBACK de BET credita de volta', async () => {
    const wallet = await openWallet(kit, '100.00');
    const betRequest = wagerRequest(wallet, { kind: 'BET', amount: '60.00' });
    await submit(kit, betRequest);

    const rollback = await submit(
      kit,
      wagerRequest(wallet, { kind: 'ROLLBACK', amount: '60.00', referenceExternalTransactionId: betRequest.externalTransactionId }),
    );
    expect(rollback).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
  });
});

describe('idempotência', () => {
  test('replay devolve o resultado original, inclusive o saldo daquele momento', async () => {
    const wallet = await openWallet(kit, '100.00');
    const betRequest = wagerRequest(wallet, { kind: 'BET', amount: '25.00' });
    const original = await submit(kit, betRequest);

    await submit(kit, wagerRequest(wallet, { kind: 'BET', amount: '50.00' }));
    const replay = await submit(kit, betRequest);

    expect(replay).toEqual({ ...original, idempotentReplay: true });
    expect(replay.balance?.amount).toBe('75.00');
    await expectWalletMatchesLedger(kit, wallet.walletId, '25.00');
  });

  test('mesma idempotency key com payload diferente é conflito, não replay', async () => {
    const wallet = await openWallet(kit, '100.00');
    const betRequest = wagerRequest(wallet, { kind: 'BET', amount: '25.00' });
    await submit(kit, betRequest);

    await expect(submit(kit, { ...betRequest, money: { amount: '26.00', currency: 'BRL' } })).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    await expectWalletMatchesLedger(kit, wallet.walletId, '75.00');
  });

  test('payload equivalente com amount em outra escala ("25" vs "25.00") é replay', async () => {
    const wallet = await openWallet(kit, '100.00');
    const betRequest = wagerRequest(wallet, { kind: 'BET', amount: '25.00' });
    await submit(kit, betRequest);
    const replay = await submit(kit, { ...betRequest, money: { amount: '25', currency: 'BRL' } });
    expect(replay.idempotentReplay).toBe(true);
  });

  test('mensagem SQS reentregue (mesmo messageId) não reaplica e mantém um único registro de inbox', async () => {
    const wallet = await openWallet(kit, '100.00');
    const betRequest = wagerRequest(wallet, { kind: 'BET', amount: '10.00' });
    const messageId = `msg-${generateId()}`;

    const firstDelivery = await submit(kit, betRequest, messageId);
    const redelivery = await submit(kit, betRequest, messageId);

    expect(firstDelivery.idempotentReplay).toBe(false);
    expect(redelivery.idempotentReplay).toBe(true);
    const [inboxCount] = await kit.orm.em.getKnex()('inbox_messages').where({ message_id: messageId }).count<{ count: string }[]>('* as count');
    expect(Number(inboxCount?.count)).toBe(1);
    await expectWalletMatchesLedger(kit, wallet.walletId, '90.00');
  });
});

describe('outbox atômica', () => {
  test('BET processada grava WalletBalanceChanged e WagerTransactionProcessed; rejeitada grava só Rejected', async () => {
    const wallet = await openWallet(kit, '10.00');
    const processed = await submit(kit, wagerRequest(wallet, { kind: 'BET', amount: '5.00' }));
    const rejected = await submit(kit, wagerRequest(wallet, { kind: 'BET', amount: '50.00' }));

    const eventTypesOf = async (transactionId: string) =>
      (
        await kit.orm.em
          .getKnex()('outbox_messages')
          .whereRaw("payload->'data'->>'transactionId' = ?", [transactionId])
          .select('event_type')
      )
        .map((row: { event_type: string }) => row.event_type)
        .sort();

    expect(await eventTypesOf(processed.transactionId)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(await eventTypesOf(rejected.transactionId)).toEqual(['WagerTransactionRejected']);
  });
});

describe('referências fora de ordem', () => {
  test('REFUND antes da BET fica PENDING_REFERENCE e é aplicado pelo worker quando a BET chega', async () => {
    const wallet = await openWallet(kit, '100.00');
    const betRequest = wagerRequest(wallet, { kind: 'BET', amount: '20.00' });
    const refundRequest = wagerRequest(wallet, {
      kind: 'REFUND',
      amount: '20.00',
      referenceExternalTransactionId: betRequest.externalTransactionId,
    });

    const pendingRefund = await submit(kit, refundRequest);
    expect(String(pendingRefund.status)).toBe('PENDING_REFERENCE');

    await submit(kit, betRequest);
    await kit.resolvePendingReferences.runOnce(500);

    const resolvedRefund = await kit.transactionQueries.getById(pendingRefund.transactionId);
    expect(resolvedRefund).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    await expectWalletMatchesLedger(kit, wallet.walletId, '100.00');
  });

  test('referência que nunca chega é REJECTED com REFERENCE_NOT_FOUND após o limite de tentativas', async () => {
    const wallet = await openWallet(kit, '100.00');
    const orphanRefund = await submit(
      kit,
      wagerRequest(wallet, { kind: 'ROLLBACK', amount: '20.00', referenceExternalTransactionId: `nunca-${generateId()}` }),
    );
    expect(String(orphanRefund.status)).toBe('PENDING_REFERENCE');

    for (let workerRun = 0; workerRun < 10; workerRun++) {
      kit.clock.advanceBy(10 * 60_000);
      await kit.resolvePendingReferences.runOnce(500);
    }

    const finalState = await kit.transactionQueries.getById(orphanRefund.transactionId);
    expect(finalState).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });
    await expectWalletMatchesLedger(kit, wallet.walletId, '100.00');
  });
});
