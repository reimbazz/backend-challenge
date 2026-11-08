import { Money } from '../money/money';
import { UnbalancedLedgerEntryError } from '../shared/domain-error';
import { generateId } from '../shared/identifiers';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface CreateLedgerEntryProps {
  walletId: string;
  transactionId: string;
  /** versão da wallet resultante deste lançamento — UNIQUE(wallet_id, wallet_version) e cursor estável */
  walletVersion: number;
  direction: LedgerDirection;
  /** sempre positivo; o sinal vem de `direction` */
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {
  id: string;
}

/**
 * Lançamento imutável do ledger: só campos readonly e nenhum método de transição.
 * No banco, um trigger bloqueia UPDATE/DELETE.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly walletVersion: number,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  /**
   * Cria um lançamento validando a aritmética.
   * @throws UnbalancedLedgerEntryError valor não positivo, moedas divergentes,
   *         before ± money ≠ after ou saldo final negativo
   */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const newEntry = new WalletLedgerEntry(
      generateId(),
      props.walletId,
      props.transactionId,
      props.walletVersion,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );

    const sameCurrencyEverywhere =
      props.money.currency === props.balanceBefore.currency &&
      props.money.currency === props.balanceAfter.currency;

    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new UnbalancedLedgerEntryError(`walletVersion inválida: ${props.walletVersion}`);
    }
    if (!sameCurrencyEverywhere) {
      throw new UnbalancedLedgerEntryError('moedas diferentes entre valor e saldos');
    }
    if (!props.money.isPositive()) {
      throw new UnbalancedLedgerEntryError(`valor deve ser positivo, recebido ${props.money}`);
    }
    if (props.balanceAfter.isNegative()) {
      throw new UnbalancedLedgerEntryError(`saldo final negativo: ${props.balanceAfter}`);
    }
    if (!newEntry.isBalanced()) {
      throw new UnbalancedLedgerEntryError(
        `${props.balanceBefore} ${props.direction} ${props.money} ≠ ${props.balanceAfter}`,
      );
    }

    return newEntry;
  }

  /** Reidrata sem revalidar — o CHECK do banco já garante a aritmética. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.walletVersion,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter */
  isBalanced(): boolean {
    const expectedBalanceAfter =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);

    return expectedBalanceAfter.equals(this.balanceAfter);
  }

  /** Efeito com sinal no saldo (+crédito / −débito), usado na reconciliação. */
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
  }
}
