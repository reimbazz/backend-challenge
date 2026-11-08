import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  countRows,
  createWageringTestKit,
  expectWalletMatchesLedger,
  openWallet,
  submit,
  wagerRequest,
  WageringTestKit,
} from '../support/wagering-test-kit';

/**
 * Paralelismo real: as chamadas disparam juntas e cada uma usa sua própria conexão do pool
 * e sua própria transação SQL. Nenhuma serialização no código de teste.
 */

let kit: WageringTestKit;

beforeAll(async () => {
  kit = await createWageringTestKit();
});

afterAll(async () => {
  await kit.orm.close(true);
});

describe('concorrência — mesma wallet', () => {
  test('a mesma aposta enviada 50 vezes em paralelo gera um único débito', async () => {
    const wallet = await openWallet(kit, '100.00');
    const betRequest = wagerRequest(wallet, { kind: 'BET', amount: '25.00' });

    const results = await Promise.all(Array.from({ length: 50 }, () => submit(kit, betRequest)));

    const firstApplications = results.filter((result) => !result.idempotentReplay);
    expect(firstApplications).toHaveLength(1);
    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(results.every((result) => result.status === 'PROCESSED' && result.balance?.amount === '75.00')).toBe(true);

    expect(await countRows(kit, 'wallet_ledger_entries', wallet.walletId, { direction: 'DEBIT' })).toBe(1);
    await expectWalletMatchesLedger(kit, wallet.walletId, '75.00');
  });

  test('cenário obrigatório: saldo 100, duas apostas de 80 simultâneas', async () => {
    const wallet = await openWallet(kit, '100.00');

    const results = await Promise.all([
      submit(kit, wagerRequest(wallet, { kind: 'BET', amount: '80.00' })),
      submit(kit, wagerRequest(wallet, { kind: 'BET', amount: '80.00' })),
    ]);

    const statuses = results.map((result) => String(result.status)).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((result) => result.status === 'REJECTED')?.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(await countRows(kit, 'wallet_ledger_entries', wallet.walletId, { direction: 'DEBIT' })).toBe(1);
    await expectWalletMatchesLedger(kit, wallet.walletId, '20.00');
  });

  test('cenário obrigatório com retries: reenviar as duas apostas não duplica o débito', async () => {
    const wallet = await openWallet(kit, '100.00');
    const firstBet = wagerRequest(wallet, { kind: 'BET', amount: '80.00' });
    const secondBet = wagerRequest(wallet, { kind: 'BET', amount: '80.00' });

    const allSubmissions = Array.from({ length: 10 }, (_, index) => submit(kit, index % 2 === 0 ? firstBet : secondBet));
    const results = await Promise.all(allSubmissions);

    const distinctOutcomes = new Map(results.map((result) => [result.transactionId, result.status]));
    expect([...distinctOutcomes.values()].map(String).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(await countRows(kit, 'wallet_ledger_entries', wallet.walletId, { direction: 'DEBIT' })).toBe(1);
    await expectWalletMatchesLedger(kit, wallet.walletId, '20.00');
  });

  test('hot wallet: 40 apostas de 10 sobre saldo 100 → exatamente 10 processadas, saldo 0', async () => {
    const wallet = await openWallet(kit, '100.00');

    const results = await Promise.all(
      Array.from({ length: 40 }, () => submit(kit, wagerRequest(wallet, { kind: 'BET', amount: '10.00' }))),
    );

    expect(results.filter((result) => result.status === 'PROCESSED')).toHaveLength(10);
    expect(results.filter((result) => result.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(30);
    await expectWalletMatchesLedger(kit, wallet.walletId, '0.00');
    expect((await kit.walletQueries.getWallet(wallet.walletId)).version).toBe(11);
  });

  test('operações mistas concorrentes (BET, WIN, LOSS, REFUND) mantêm saldo == ledger', async () => {
    const wallet = await openWallet(kit, '500.00');
    const bets = Array.from({ length: 10 }, () => wagerRequest(wallet, { kind: 'BET', amount: '20.00' }));
    await Promise.all(bets.map((bet) => submit(kit, bet)));

    await Promise.all([
      ...bets.slice(0, 5).map((bet) =>
        submit(kit, wagerRequest(wallet, { kind: 'REFUND', amount: '20.00', referenceExternalTransactionId: bet.externalTransactionId })),
      ),
      ...Array.from({ length: 5 }, () => submit(kit, wagerRequest(wallet, { kind: 'WIN', amount: '7.50' }))),
      ...Array.from({ length: 5 }, () => submit(kit, wagerRequest(wallet, { kind: 'LOSS', amount: '0.00' }))),
      ...Array.from({ length: 5 }, () => submit(kit, wagerRequest(wallet, { kind: 'BET', amount: '3.33' }))),
    ]);

    // 500 − 10×20 + 5×20 + 5×7.50 − 5×3.33 = 420.85
    await expectWalletMatchesLedger(kit, wallet.walletId, '420.85');
  });
});

describe('concorrência — wallets distintas', () => {
  test('20 wallets processadas em paralelo, cada uma consistente', async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet(kit, '50.00')));

    await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 6 }, () => submit(kit, wagerRequest(wallet, { kind: 'BET', amount: '10.00' }))),
      ),
    );

    for (const wallet of wallets) {
      await expectWalletMatchesLedger(kit, wallet.walletId, '0.00');
      expect(await countRows(kit, 'wallet_ledger_entries', wallet.walletId, { direction: 'DEBIT' })).toBe(5);
    }
  });
});
