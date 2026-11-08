import { describe, expect, test } from 'bun:test';
import { Money } from '../../src/domain/money/money';
import { CurrencyMismatchError, InvalidMoneyError } from '../../src/domain/shared/domain-error';

/** Atalho para criar BRL nos testes. */
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

describe('Money', () => {
  describe('entrada válida', () => {
    test('normaliza para escala fixa de 2 casas', () => {
      expect(brl('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
      expect(brl('25.5').toJSON()).toEqual({ amount: '25.50', currency: 'BRL' });
      expect(brl('0.01').toString()).toBe('0.01 BRL');
    });

    test('aceita valores muito grandes sem perder precisão', () => {
      expect(brl('99999999999999999.99').toAmountString()).toBe('99999999999999999.99');
    });
  });

  describe('entrada inválida', () => {
    const invalidAmounts = [
      'NaN',
      'Infinity',
      '-Infinity',
      '1e3',
      '1E-2',
      '',
      ' ',
      '10.001',
      '-5.00',
      '+5.00',
      '1,50',
      '12.',
      '.50',
      'abc',
      ' 10.00',
    ];

    for (const invalidAmount of invalidAmounts) {
      test(`rejeita amount "${invalidAmount}"`, () => {
        expect(() => brl(invalidAmount)).toThrow(InvalidMoneyError);
      });
    }

    test('rejeita amount que não é string (number)', () => {
      expect(() => Money.from({ amount: 10 as unknown as string, currency: 'BRL' })).toThrow(InvalidMoneyError);
    });

    test('rejeita moeda fora do formato ISO-4217', () => {
      expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '1.00', currency: 'REAL' })).toThrow(InvalidMoneyError);
      expect(() => Money.from({ amount: '1.00', currency: '' })).toThrow(InvalidMoneyError);
    });
  });

  describe('aritmética exata', () => {
    test('0.10 + 0.20 é exatamente 0.30 (o clássico erro do float não acontece)', () => {
      expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    });

    test('subtrai e pode gerar negativo (quem protege o saldo é a Wallet)', () => {
      const result = brl('10.00').subtract(brl('25.50'));
      expect(result.isNegative()).toBe(true);
      expect(result.toAmountString()).toBe('-15.50');
    });

    test('negate inverte o sinal', () => {
      expect(brl('3.10').negate().toAmountString()).toBe('-3.10');
    });

    test('é imutável: operações não alteram a instância original', () => {
      const original = brl('10.00');
      original.add(brl('5.00'));
      original.subtract(brl('1.00'));
      expect(original.toAmountString()).toBe('10.00');
    });

    test('soma de valores grandes não perde centavos (precisão acima de 20 dígitos)', () => {
      const largeSum = brl('99999999999999999.99').add(brl('0.01'));
      expect(largeSum.toAmountString()).toBe('100000000000000000.00');
    });

    test('somar mil vezes 0.01 resulta em exatamente 10.00', () => {
      let accumulated = Money.zero('BRL');
      for (let iteration = 0; iteration < 1000; iteration++) {
        accumulated = accumulated.add(brl('0.01'));
      }
      expect(accumulated.toAmountString()).toBe('10.00');
    });
  });

  describe('comparações', () => {
    test('isZero, isPositive, isNegative, isLessThan', () => {
      expect(Money.zero('BRL').isZero()).toBe(true);
      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
      expect(brl('1.01').isLessThan(brl('1.01'))).toBe(false);
    });

    test('equals considera valor e moeda', () => {
      expect(brl('1.00').equals(brl('1'))).toBe(true);
      expect(brl('1.00').equals(Money.from({ amount: '1.00', currency: 'USD' }))).toBe(false);
    });
  });

  describe('conflito de moeda', () => {
    const usd = Money.from({ amount: '1.00', currency: 'USD' });

    test('add, subtract e isLessThan lançam CurrencyMismatchError', () => {
      expect(() => brl('1.00').add(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl('1.00').subtract(usd)).toThrow(CurrencyMismatchError);
      expect(() => brl('1.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
    });
  });

  describe('reidratação do banco', () => {
    test('aceita valores negativos e normaliza a escala', () => {
      expect(Money.rehydrate('-12.5', 'BRL').toAmountString()).toBe('-12.50');
      expect(Money.rehydrate('975.000000', 'BRL').toAmountString()).toBe('975.00');
    });
  });

  test('JSON.stringify usa o formato de contrato', () => {
    expect(JSON.stringify({ money: brl('25') })).toBe('{"money":{"amount":"25.00","currency":"BRL"}}');
  });
});
