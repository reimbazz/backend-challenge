import { LedgerDirection, WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { CurrencyMismatchError, InsufficientFundsError, InvalidMoneyError } from '../shared/domain-error';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /** usado apenas se o saldo inicial for > 0 */
  openingTransactionId: string;
  openedAt: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  openingLedgerEntry: WalletLedgerEntry | undefined;
}

/**
 * Aggregate Root. Garante: saldo nunca negativo, toda mudança de saldo gera um lançamento,
 * moeda única e `version` incrementando só quando o saldo muda.
 * Concorrência entre instâncias é resolvida na persistência (SELECT ... FOR UPDATE + CHECK).
 */
export class Wallet {
  static readonly INITIAL_VERSION = 1;

  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet com version 1. Saldo inicial > 0 gera o lançamento CREDIT da transação OPENING.
   * @throws InvalidMoneyError saldo inicial negativo
   */
  static open(props: OpenWalletProps): OpenedWallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError('saldo inicial não pode ser negativo');
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      Wallet.INITIAL_VERSION,
      props.openedAt,
      props.openedAt,
    );

    const openingLedgerEntry = props.initialBalance.isPositive()
      ? WalletLedgerEntry.create({
          walletId: wallet.id,
          transactionId: props.openingTransactionId,
          walletVersion: Wallet.INITIAL_VERSION,
          direction: LedgerDirection.Credit,
          money: props.initialBalance,
          balanceBefore: Money.zero(wallet.currency),
          balanceAfter: props.initialBalance,
          createdAt: props.openedAt,
        })
      : undefined;

    return { wallet, openingLedgerEntry };
  }

  /** Reidrata sem revalidar regras. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Consulta sem efeito colateral. */
  canDebit(amountToDebit: Money): boolean {
    this.assertSameCurrency(amountToDebit);
    return !this._balance.isLessThan(amountToDebit);
  }

  /**
   * @returns lançamento DEBIT
   * @throws InsufficientFundsError | CurrencyMismatchError
   */
  debit(amountToDebit: Money, transactionId: string, occurredAt: Date): WalletLedgerEntry {
    if (!this.canDebit(amountToDebit)) {
      throw new InsufficientFundsError(this._balance.toString(), amountToDebit.toString());
    }
    return this.applyMovement(LedgerDirection.Debit, amountToDebit, transactionId, occurredAt);
  }

  /**
   * @returns lançamento CREDIT
   * @throws CurrencyMismatchError
   */
  credit(amountToCredit: Money, transactionId: string, occurredAt: Date): WalletLedgerEntry {
    this.assertSameCurrency(amountToCredit);
    return this.applyMovement(LedgerDirection.Credit, amountToCredit, transactionId, occurredAt);
  }

  /**
   * Único ponto de mutação do saldo. O lançamento é criado (e validado) antes de alterar o estado,
   * então saldo e ledger nunca divergem.
   */
  private applyMovement(
    direction: LedgerDirection,
    movementAmount: Money,
    transactionId: string,
    occurredAt: Date,
  ): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? balanceBefore.add(movementAmount)
        : balanceBefore.subtract(movementAmount);

    const nextVersion = this._version + 1;

    const ledgerEntry = WalletLedgerEntry.create({
      walletId: this.id,
      transactionId,
      walletVersion: nextVersion,
      direction,
      money: movementAmount,
      balanceBefore,
      balanceAfter,
      createdAt: occurredAt,
    });

    this._balance = balanceAfter;
    this._version = nextVersion;
    this._updatedAt = occurredAt;

    return ledgerEntry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
