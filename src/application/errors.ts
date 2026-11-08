/**
 * Erros da camada de aplicação. Cada classe corresponde a uma categoria que as bordas
 * mapeiam de forma consistente (HTTP status / ack-retry-DLQ no SQS):
 *
 *   InvalidRequestError          → 400, SQS: permanente (DLQ)
 *   NotFoundError                → 404
 *   IdempotencyConflictError     → 409, SQS: permanente (DLQ)
 *   WalletAlreadyExistsError     → 409
 *   TransientInfrastructureError → 503, SQS: retry
 *   InvariantViolationError      → 500, SQS: permanente (DLQ) — indica bug
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
  }
}

export class InvalidRequestError extends ApplicationError {
  readonly code = 'INVALID_REQUEST';

  constructor(message: string, readonly details?: unknown) {
    super(message);
  }
}

export class NotFoundError extends ApplicationError {
  readonly code = 'NOT_FOUND';

  constructor(resource: string, identifier: string) {
    super(`${resource} não encontrado: ${identifier}`);
  }
}

/** Mesma idempotency key (ou mesmo externalTransactionId) com payload diferente. */
export class IdempotencyConflictError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(message: string, readonly existingTransactionId: string) {
    super(message);
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(playerId: string, currency: string) {
    super(`já existe wallet para o player ${playerId} em ${currency}`);
  }
}

/** Banco/broker indisponível, lock timeout, deadlock, conflito de versão: seguro tentar de novo. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_INFRASTRUCTURE_FAILURE';

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

/** UPDATE condicionado à versão não afetou linhas. */
export class ConcurrencyConflictError extends TransientInfrastructureError {
  constructor(walletId: string) {
    super(`versão da wallet ${walletId} mudou durante a operação`);
  }
}

/** Violação de unicidade no banco — tratada pelos use cases (replay/conflito). */
export class UniqueConstraintConflictError extends ApplicationError {
  readonly code = 'UNIQUE_CONSTRAINT_CONFLICT';

  constructor(readonly constraintName: string | undefined, cause?: unknown) {
    super(`violação de unicidade: ${constraintName ?? 'desconhecida'}`, cause);
  }
}

/** CHECK/trigger de consistência recusou o commit — nunca deveria acontecer. */
export class InvariantViolationError extends ApplicationError {
  readonly code = 'INVARIANT_VIOLATION';

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}
