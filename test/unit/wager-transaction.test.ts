import { describe, expect, test } from 'bun:test';
import { computeWagerPayloadHash } from '../../src/application/wagering/payload-hash';
import { LedgerDirection } from '../../src/domain/ledger/wallet-ledger-entry';
import { Money } from '../../src/domain/money/money';
import { InvalidTransactionStateError, InvalidWagerRequestError } from '../../src/domain/shared/domain-error';
import { FailureCode } from '../../src/domain/wagering/failure-code';
import {
  CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../src/domain/wagering/wager-transaction';

const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });
const now = new Date('2026-11-06T12:00:00.000Z');

/** Transação PENDING com valores padrão. */
function buildTransaction(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  return WagerTransaction.create({
    id: overrides.id ?? 'tx-' + Math.random().toString(36).slice(2),
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    createdAt: now,
    ...overrides,
  });
}

/** Transação PROCESSED para servir de referência. */
function buildProcessed(kind: WagerTransactionKind, amount = '25.00'): WagerTransaction {
  const transaction = buildTransaction({
    kind,
    money: brl(amount),
    referenceExternalTransactionId: kind === WagerTransactionKind.Rollback || kind === WagerTransactionKind.Refund ? 'x' : undefined,
  });
  transaction.markProcessed(undefined, brl('100.00'), now);
  return transaction;
}

describe('WagerTransaction — criação', () => {
  test('nasce em PENDING', () => {
    expect(buildTransaction().status).toBe(WagerTransactionStatus.Pending);
  });

  test('OPENING não pode ser submetido de fora', () => {
    expect(() => buildTransaction({ kind: WagerTransactionKind.Opening })).toThrow(InvalidWagerRequestError);
  });

  test('REFUND e ROLLBACK exigem referência', () => {
    expect(() => buildTransaction({ kind: WagerTransactionKind.Refund })).toThrow(InvalidWagerRequestError);
    expect(() => buildTransaction({ kind: WagerTransactionKind.Rollback })).toThrow(InvalidWagerRequestError);
  });

  test('BET de valor zero é inválido; LOSS de valor zero é aceito', () => {
    expect(() => buildTransaction({ money: Money.zero('BRL') })).toThrow(InvalidWagerRequestError);
    expect(buildTransaction({ kind: WagerTransactionKind.Loss, money: Money.zero('BRL') }).status).toBe(
      WagerTransactionStatus.Pending,
    );
  });

  test('OPENING interna nasce PROCESSED com o saldo inicial', () => {
    const opening = WagerTransaction.createOpening({
      id: 'op-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl('1000.00'),
      createdAt: now,
    });
    expect(opening.status).toBe(WagerTransactionStatus.Processed);
    expect(opening.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });
});

describe('WagerTransaction — regras por tipo', () => {
  test('BET debita; WIN e REFUND creditam; LOSS não afeta saldo', () => {
    expect(buildTransaction().ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(buildTransaction({ kind: WagerTransactionKind.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(
      buildTransaction({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'bet' }).ledgerDirectionFor(),
    ).toBe(LedgerDirection.Credit);

    const loss = buildTransaction({ kind: WagerTransactionKind.Loss });
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow(InvalidWagerRequestError);
  });

  test('ROLLBACK inverte o sentido da referência', () => {
    const rollback = buildTransaction({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'ref' });

    expect(rollback.ledgerDirectionFor(buildProcessed(WagerTransactionKind.Bet))).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(buildProcessed(WagerTransactionKind.Win))).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(buildProcessed(WagerTransactionKind.Refund))).toBe(LedgerDirection.Debit);
  });

  test('REFUND só referencia BET', () => {
    const refund = buildTransaction({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ref' });

    expect(refund.checkReference(buildProcessed(WagerTransactionKind.Bet))).toEqual({ outcome: 'COMPATIBLE' });
    expect(refund.checkReference(buildProcessed(WagerTransactionKind.Win))).toEqual({
      outcome: 'INCOMPATIBLE',
      failureCode: FailureCode.InvalidReferenceKind,
    });
  });

  test('ROLLBACK referencia BET, WIN ou REFUND, mas não LOSS', () => {
    const rollback = buildTransaction({ kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: 'ref' });

    for (const allowedKind of [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund]) {
      expect(rollback.checkReference(buildProcessed(allowedKind)).outcome).toBe('COMPATIBLE');
    }
    expect(rollback.checkReference(buildProcessed(WagerTransactionKind.Loss)).outcome).toBe('INCOMPATIBLE');
  });

  test('reversão com valor diferente da referência é rejeitada', () => {
    const refund = buildTransaction({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'ref',
      money: brl('10.00'),
    });
    expect(refund.checkReference(buildProcessed(WagerTransactionKind.Bet, '25.00'))).toEqual({
      outcome: 'INCOMPATIBLE',
      failureCode: FailureCode.ReversalAmountMismatch,
    });
  });

  test('referência de outra rodada ou outro player é rejeitada', () => {
    const refund = buildTransaction({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ref' });
    const betFromAnotherRound = buildTransaction({ roundId: 'round-2' });
    betFromAnotherRound.markProcessed(undefined, brl('1.00'), now);

    expect(refund.checkReference(betFromAnotherRound)).toEqual({
      outcome: 'INCOMPATIBLE',
      failureCode: FailureCode.ReferenceMismatch,
    });
  });

  test('referência rejeitada não pode ser revertida; referência ainda pendente → aguardar', () => {
    const refund = buildTransaction({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ref' });

    const rejectedBet = buildTransaction();
    rejectedBet.reject(FailureCode.InsufficientFunds, brl('0.00'), now);
    expect(refund.checkReference(rejectedBet)).toEqual({
      outcome: 'INCOMPATIBLE',
      failureCode: FailureCode.ReferenceNotProcessed,
    });

    expect(refund.checkReference(buildTransaction())).toEqual({ outcome: 'WAIT' });
  });
});

describe('WagerTransaction — máquina de estados', () => {
  test('estados terminais não aceitam nova transição', () => {
    const processed = buildTransaction();
    processed.markProcessed(undefined, brl('75.00'), now);

    expect(() => processed.reject(FailureCode.InsufficientFunds, undefined, now)).toThrow(InvalidTransactionStateError);
    expect(() => processed.markProcessed(undefined, brl('1.00'), now)).toThrow(InvalidTransactionStateError);
    expect(() => processed.fail(FailureCode.ProcessingError, now)).toThrow(InvalidTransactionStateError);
    expect(() => processed.markPendingReference(now)).toThrow(InvalidTransactionStateError);
  });

  test('PENDING_REFERENCE agenda tentativas com backoff exponencial e esgota no limite', () => {
    const refund = buildTransaction({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'ref' });

    refund.markPendingReference(now);
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refund.nextReferenceResolutionAt!.getTime() - now.getTime()).toBe(2_000);

    refund.markPendingReference(now);
    expect(refund.nextReferenceResolutionAt!.getTime() - now.getTime()).toBe(4_000);

    while (!refund.hasExhaustedReferenceResolution()) {
      refund.markPendingReference(now);
    }
    expect(refund.referenceResolutionAttempts).toBe(WagerTransaction.MAX_REFERENCE_RESOLUTION_ATTEMPTS);

    refund.reject(FailureCode.ReferenceNotFound, undefined, now);
    expect(refund.isTerminal()).toBe(true);
  });
});

describe('Idempotência — payloadHash', () => {
  const basePayload = {
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };

  test('mesmo conteúdo em ordem diferente gera o mesmo hash', () => {
    const reorderedPayload = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: 'fortune-chimp',
      roundId: 'round-1',
      walletId: 'wallet-1',
      playerId: 'player-1',
      externalTransactionId: 'ext-1',
      providerId: 'provider-a',
    };
    expect(computeWagerPayloadHash(reorderedPayload)).toBe(computeWagerPayloadHash(basePayload));
  });

  test('mesma idempotency key com payload divergente → hash diferente → conflito, não replay', () => {
    const originalTransaction = buildTransaction({ payloadHash: computeWagerPayloadHash(basePayload) });
    const divergentHash = computeWagerPayloadHash({ ...basePayload, money: { amount: '26.00', currency: 'BRL' } });

    expect(originalTransaction.matchesPayload(computeWagerPayloadHash(basePayload))).toBe(true);
    expect(originalTransaction.matchesPayload(divergentHash)).toBe(false);
  });
});
