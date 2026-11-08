import { describe, expect, test } from 'bun:test';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../src/domain/money/money';
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  UnbalancedLedgerEntryError,
} from '../../src/domain/shared/domain-error';
import { Wallet } from '../../src/domain/wallet/wallet';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-11-06T12:00:00.000Z');

function openTestWallet(initialAmount: string) {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initialAmount),
    openingTransactionId: 'opening-tx',
    openedAt: now,
  });
}

describe('Wallet', () => {
  test('abre com version 1 e lançamento de abertura quando o saldo inicial é positivo', () => {
    const { wallet, openingLedgerEntry } = openTestWallet('100.00');

    expect(wallet.version).toBe(1);
    expect(wallet.balance.toAmountString()).toBe('100.00');
    expect(openingLedgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingLedgerEntry?.balanceBefore.toAmountString()).toBe('0.00');
    expect(openingLedgerEntry?.balanceAfter.toAmountString()).toBe('100.00');
  });

  test('abre sem lançamento quando o saldo inicial é zero', () => {
    const { wallet, openingLedgerEntry } = openTestWallet('0.00');
    expect(wallet.version).toBe(1);
    expect(openingLedgerEntry).toBeUndefined();
  });

  test('débito reduz o saldo, incrementa a versão e devolve o lançamento DEBIT', () => {
    const { wallet } = openTestWallet('100.00');
    const debitEntry = wallet.debit(brl('80.00'), 'tx-1', now);

    expect(wallet.balance.toAmountString()).toBe('20.00');
    expect(wallet.version).toBe(2);
    expect(debitEntry.direction).toBe(LedgerDirection.Debit);
    expect(debitEntry.isBalanced()).toBe(true);
  });

  test('débito maior que o saldo lança InsufficientFundsError e NÃO altera a wallet', () => {
    const { wallet } = openTestWallet('100.00');
    wallet.debit(brl('80.00'), 'tx-1', now);

    expect(() => wallet.debit(brl('80.00'), 'tx-2', now)).toThrow(InsufficientFundsError);
    expect(wallet.balance.toAmountString()).toBe('20.00');
    expect(wallet.version).toBe(2);
  });

  test('débito exatamente igual ao saldo zera a wallet (permitido)', () => {
    const { wallet } = openTestWallet('50.00');
    wallet.debit(brl('50.00'), 'tx-1', now);
    expect(wallet.balance.isZero()).toBe(true);
  });

  test('crédito aumenta o saldo e incrementa a versão', () => {
    const { wallet } = openTestWallet('10.00');
    const creditEntry = wallet.credit(brl('5.55'), 'tx-1', now);

    expect(wallet.balance.toAmountString()).toBe('15.55');
    expect(wallet.version).toBe(2);
    expect(creditEntry.direction).toBe(LedgerDirection.Credit);
  });

  test('operação em moeda diferente da wallet lança CurrencyMismatchError', () => {
    const { wallet } = openTestWallet('10.00');
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    expect(() => wallet.debit(usd, 'tx-1', now)).toThrow(CurrencyMismatchError);
    expect(() => wallet.credit(usd, 'tx-1', now)).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test('movimento de valor zero é recusado e a wallet não muda', () => {
    const { wallet } = openTestWallet('10.00');
    expect(() => wallet.credit(Money.zero('BRL'), 'tx-1', now)).toThrow(UnbalancedLedgerEntryError);
    expect(wallet.version).toBe(1);
  });

  test('saldo da wallet sempre bate com a soma dos lançamentos', () => {
    const { wallet, openingLedgerEntry } = openTestWallet('100.00');
    const allEntries: WalletLedgerEntry[] = [openingLedgerEntry!];

    allEntries.push(wallet.debit(brl('30.00'), 'tx-1', now));
    allEntries.push(wallet.credit(brl('12.34'), 'tx-2', now));
    allEntries.push(wallet.debit(brl('0.01'), 'tx-3', now));

    const balanceRebuiltFromLedger = allEntries.reduce(
      (runningBalance, entry) => runningBalance.add(entry.signedAmount()),
      Money.zero('BRL'),
    );
    expect(balanceRebuiltFromLedger.equals(wallet.balance)).toBe(true);
  });
});

describe('WalletLedgerEntry', () => {
  const baseEntryProps = {
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    createdAt: now,
  };

  test('recusa lançamento com aritmética errada', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...baseEntryProps,
        direction: LedgerDirection.Credit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: brl('16.00'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('recusa lançamento que deixaria saldo negativo', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...baseEntryProps,
        direction: LedgerDirection.Debit,
        money: brl('10.00'),
        balanceBefore: brl('5.00'),
        balanceAfter: Money.rehydrate('-5.00', 'BRL'),
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  test('não expõe nenhum método que altere estado', () => {
    const entryMethodNames = Object.getOwnPropertyNames(WalletLedgerEntry.prototype);
    expect(entryMethodNames.sort()).toEqual(['constructor', 'isBalanced', 'signedAmount'].sort());
  });
});
