import DecimalLibrary from 'decimal.js';
import { CurrencyMismatchError, InvalidMoneyError } from '../shared/domain-error';

/**
 * Instância isolada do Decimal com 40 dígitos de precisão (o padrão de 20 arredondaria
 * somas grandes). Nenhuma operação do sistema arredonda implicitamente.
 */
const Decimal = DecimalLibrary.clone({ precision: 40, rounding: DecimalLibrary.ROUND_HALF_EVEN });
type Decimal = InstanceType<typeof Decimal>;

/** Formato de contrato: valor sempre como string decimal, nunca number. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

export const MONEY_SCALE = 2;

/** Só dígitos com até 2 casas: rejeita negativo, sinal, notação científica, NaN, Infinity e vazio. */
const NON_NEGATIVE_DECIMAL_PATTERN = /^\d+(\.\d{1,2})?$/;

/** ISO-4217. */
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

/** Value Object monetário, imutável, com aritmética decimal exata. */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  /**
   * Cria a partir de contrato de entrada (HTTP/SQS).
   * @throws InvalidMoneyError formato inválido, mais de 2 casas ou valor negativo
   */
  static from(props: MoneyProps): Money {
    if (typeof props?.amount !== 'string') {
      throw new InvalidMoneyError('amount deve ser uma string decimal');
    }
    if (!NON_NEGATIVE_DECIMAL_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(
        `"${props.amount}" não é um decimal não-negativo com no máximo ${MONEY_SCALE} casas`,
      );
    }

    const validatedCurrency = Money.validateCurrency(props.currency);
    return new Money(new Decimal(props.amount).toDecimalPlaces(MONEY_SCALE), validatedCurrency);
  }

  /** Reidrata do banco. Aceita negativos (ex.: diferença da reconciliação). */
  static rehydrate(amount: string, currency: string): Money {
    const parsedValue = new Decimal(amount);
    if (!parsedValue.isFinite()) {
      throw new InvalidMoneyError(`valor persistido não é finito: ${amount}`);
    }
    return new Money(parsedValue.toDecimalPlaces(MONEY_SCALE), Money.validateCurrency(currency));
  }

  static zero(currency: string): Money {
    return new Money(new Decimal(0), Money.validateCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  /** Pode resultar negativo — a não-negatividade do saldo é responsabilidade da Wallet. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  /** Igualdade por valor; moedas diferentes retornam false sem lançar. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toAmountString(), currency: this.currency };
  }

  /** Valor com escala fixa de 2 casas, sem moeda (usado na persistência). */
  toAmountString(): string {
    return this.value.toFixed(MONEY_SCALE);
  }

  toString(): string {
    return `${this.toAmountString()} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static validateCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_CODE_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`moeda "${String(currency)}" não é um código ISO-4217`);
    }
    return currency;
  }
}
