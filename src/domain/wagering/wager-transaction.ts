import { LedgerDirection } from '../ledger/wallet-ledger-entry';
import { Money } from '../money/money';
import { InvalidTransactionStateError, InvalidWagerRequestError } from '../shared/domain-error';
import { FailureCode } from './failure-code';

export enum WagerTransactionKind {
  /** interno: crédito de abertura da wallet */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

/** Tipos aceitos pela API e pela fila (OPENING fica de fora). */
export const EXTERNAL_WAGER_KINDS = [
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
] as const;

/**
 * Transições válidas:
 *   PENDING           → PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
 *   PENDING_REFERENCE → PENDING_REFERENCE (nova tentativa) | PROCESSED | REJECTED | FAILED
 * PROCESSED, REJECTED e FAILED são terminais.
 */
export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Regra 3 da seção 7 (WIN pode, opcionalmente, referenciar a BET). */
const ALLOWED_REFERENCE_KINDS: Partial<Record<WagerTransactionKind, ReadonlySet<WagerTransactionKind>>> = {
  [WagerTransactionKind.Win]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Refund]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Rollback]: new Set([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ]),
};

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
  createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string | undefined;
  failureCode?: FailureCode | undefined;
  processedAt?: Date | undefined;
  /** saldo observado ao finalizar — devolvido em replays (regra 7) */
  resultingBalance?: Money | undefined;
  referenceResolutionAttempts: number;
  nextReferenceResolutionAt?: Date | undefined;
}

/** WAIT = referência existe mas ainda não é terminal. */
export type ReferenceCheckResult =
  | { outcome: 'COMPATIBLE' }
  | { outcome: 'WAIT' }
  | { outcome: 'INCOMPATIBLE'; failureCode: FailureCode };

export class WagerTransaction {
  /** Limite de tentativas para PENDING_REFERENCE (~8,5 min somando o backoff). */
  static readonly MAX_REFERENCE_RESOLUTION_ATTEMPTS = 8;
  static readonly REFERENCE_RETRY_BASE_DELAY_MS = 2_000;
  static readonly REFERENCE_RETRY_MAX_DELAY_MS = 5 * 60_000;

  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _resultingBalance: Money | undefined,
    private _referenceResolutionAttempts: number,
    private _nextReferenceResolutionAt: Date | undefined,
  ) {}

  /**
   * Transação de provedor, nasce em PENDING.
   * @throws InvalidWagerRequestError OPENING externo, REFUND/ROLLBACK sem referência,
   *         ou valor zero em operação que move saldo
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerRequestError('OPENING é uma operação interna e não pode ser submetida');
    }
    if (!(EXTERNAL_WAGER_KINDS as readonly string[]).includes(props.kind)) {
      throw new InvalidWagerRequestError(`tipo de operação desconhecido: ${String(props.kind)}`);
    }

    const referenceIsRequired =
      props.kind === WagerTransactionKind.Refund || props.kind === WagerTransactionKind.Rollback;
    if (referenceIsRequired && !props.referenceExternalTransactionId) {
      throw new InvalidWagerRequestError(`${props.kind} exige referenceExternalTransactionId`);
    }

    const movesBalance = props.kind !== WagerTransactionKind.Loss;
    if (movesBalance && !props.money.isPositive()) {
      throw new InvalidWagerRequestError(`${props.kind} exige valor maior que zero`);
    }

    return WagerTransaction.fromCreateProps(props, WagerTransactionStatus.Pending);
  }

  /** OPENING interna: nasce PROCESSED, gravada na mesma transação SQL da criação da wallet. */
  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    initialBalance: Money;
    createdAt: Date;
  }): WagerTransaction {
    const openingTransaction = WagerTransaction.fromCreateProps(
      {
        id: props.id,
        providerId: 'internal',
        externalTransactionId: `opening:${props.walletId}`,
        idempotencyKey: `internal:opening:${props.walletId}`,
        payloadHash: 'internal',
        walletId: props.walletId,
        playerId: props.playerId,
        roundId: 'opening',
        gameId: 'internal',
        kind: WagerTransactionKind.Opening,
        money: props.initialBalance,
        createdAt: props.createdAt,
      },
      WagerTransactionStatus.Processed,
    );
    openingTransaction._processedAt = props.createdAt;
    openingTransaction._resultingBalance = props.initialBalance;
    return openingTransaction;
  }

  /** Reidrata sem revalidar transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.resultingBalance,
      state.referenceResolutionAttempts,
      state.nextReferenceResolutionAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }
  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }
  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }
  get processedAt(): Date | undefined {
    return this._processedAt;
  }
  get resultingBalance(): Money | undefined {
    return this._resultingBalance;
  }
  get referenceResolutionAttempts(): number {
    return this._referenceResolutionAttempts;
  }
  get nextReferenceResolutionAt(): Date | undefined {
    return this._nextReferenceResolutionAt;
  }

  // ---- transições (todas lançam InvalidTransactionStateError a partir de estado terminal)

  markProcessed(referenceTransactionId: string | undefined, resultingBalance: Money, processedAt: Date): void {
    this.assertNotTerminal('markProcessed');
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._resultingBalance = resultingBalance;
    this._processedAt = processedAt;
    this._nextReferenceResolutionAt = undefined;
  }

  /** Agenda a próxima tentativa com backoff exponencial: 2s, 4s, 8s... até 5 min. */
  markPendingReference(now: Date): void {
    this.assertNotTerminal('markPendingReference');

    const exponentialDelayMs =
      WagerTransaction.REFERENCE_RETRY_BASE_DELAY_MS * 2 ** this._referenceResolutionAttempts;
    const cappedDelayMs = Math.min(exponentialDelayMs, WagerTransaction.REFERENCE_RETRY_MAX_DELAY_MS);

    this._status = WagerTransactionStatus.PendingReference;
    this._referenceResolutionAttempts += 1;
    this._nextReferenceResolutionAt = new Date(now.getTime() + cappedDelayMs);
  }

  /** Rejeição de negócio: não altera saldo nem gera ledger. */
  reject(failureCode: FailureCode, observedBalance: Money | undefined, rejectedAt: Date): void {
    this.assertNotTerminal('reject');
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = failureCode;
    this._resultingBalance = observedBalance;
    this._processedAt = rejectedAt;
    this._nextReferenceResolutionAt = undefined;
  }

  /** Falha permanente de infraestrutura (terminal, auditável). */
  fail(failureCode: FailureCode, failedAt: Date): void {
    this.assertNotTerminal('fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = failureCode;
    this._processedAt = failedAt;
    this._nextReferenceResolutionAt = undefined;
  }

  // ---- consultas

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** false para LOSS */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  /** true para REFUND e ROLLBACK */
  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  /** inclui a referência opcional do WIN */
  hasReference(): boolean {
    return this.referenceExternalTransactionId !== undefined;
  }

  isReversal(): boolean {
    return this.requiresReference();
  }

  /** false = mesma idempotency key com payload diferente → conflito, não replay. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * BET → DEBIT; OPENING/WIN/REFUND → CREDIT; ROLLBACK → inverso da referência.
   * @throws InvalidWagerRequestError para LOSS ou ROLLBACK sem referência
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidWagerRequestError('ROLLBACK precisa da transação referenciada');
        }
        const referenceDirection = reference.ledgerDirectionFor();
        return referenceDirection === LedgerDirection.Debit ? LedgerDirection.Credit : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidWagerRequestError('LOSS não gera lançamento de ledger');
    }
  }

  /**
   * Regras 2, 3 e 5 da seção 7. A regra 4 (reverter uma única vez) depende do banco
   * e fica no use case + índice único parcial.
   */
  checkReference(reference: WagerTransaction): ReferenceCheckResult {
    const belongsToSameContext =
      reference.providerId === this.providerId &&
      reference.playerId === this.playerId &&
      reference.walletId === this.walletId &&
      reference.roundId === this.roundId &&
      reference.money.currency === this.money.currency;

    if (!belongsToSameContext) {
      return { outcome: 'INCOMPATIBLE', failureCode: FailureCode.ReferenceMismatch };
    }

    const allowedKinds = ALLOWED_REFERENCE_KINDS[this.kind];
    if (!allowedKinds || !allowedKinds.has(reference.kind)) {
      return { outcome: 'INCOMPATIBLE', failureCode: FailureCode.InvalidReferenceKind };
    }

    if (!reference.isTerminal()) {
      return { outcome: 'WAIT' };
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return { outcome: 'INCOMPATIBLE', failureCode: FailureCode.ReferenceNotProcessed };
    }

    if (this.isReversal() && !reference.money.equals(this.money)) {
      return { outcome: 'INCOMPATIBLE', failureCode: FailureCode.ReversalAmountMismatch };
    }

    return { outcome: 'COMPATIBLE' };
  }

  hasExhaustedReferenceResolution(): boolean {
    return this._referenceResolutionAttempts >= WagerTransaction.MAX_REFERENCE_RESOLUTION_ATTEMPTS;
  }

  private static fromCreateProps(
    props: CreateWagerTransactionProps,
    initialStatus: WagerTransactionStatus,
  ): WagerTransaction {
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      initialStatus,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  private assertNotTerminal(attemptedTransition: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, attemptedTransition);
    }
  }
}
