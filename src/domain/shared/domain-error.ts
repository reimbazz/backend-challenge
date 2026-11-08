/**
 * Base dos erros de regra de negócio. Permite às bordas (HTTP/SQS) separar
 * erro de domínio (terminal, sem retry) de falha de infraestrutura (retry).
 */
export abstract class DomainError extends Error {
  /** Código estável, legível por máquina. */
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';

  constructor(reason: string) {
    super(`Valor monetário inválido: ${reason}`);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';

  constructor(expectedCurrency: string, receivedCurrency: string) {
    super(`Moeda divergente: esperado ${expectedCurrency}, recebido ${receivedCurrency}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';

  constructor(currentBalance: string, requestedAmount: string) {
    super(`Saldo insuficiente: saldo ${currentBalance}, débito solicitado ${requestedAmount}`);
  }
}

/** Transição a partir de estado terminal — erro de programação, não caminho de negócio. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';

  constructor(transactionId: string, currentStatus: string, attemptedTransition: string) {
    super(
      `Transação ${transactionId} está em ${currentStatus} (terminal) e não pode executar "${attemptedTransition}"`,
    );
  }
}

export class UnbalancedLedgerEntryError extends DomainError {
  readonly code = 'UNBALANCED_LEDGER_ENTRY';

  constructor(details: string) {
    super(`Lançamento de ledger desbalanceado: ${details}`);
  }
}

/** Violação estrutural do pedido (ex.: REFUND sem referência, OPENING vindo de fora). */
export class InvalidWagerRequestError extends DomainError {
  readonly code = 'INVALID_WAGER_REQUEST';

  constructor(reason: string) {
    super(`Requisição de transação inválida: ${reason}`);
  }
}
