/**
 * Taxonomia de falhas — contrato público, nunca renomear.
 *
 * | Código                      | Status   | Ação do provedor                          |
 * |-----------------------------|----------|-------------------------------------------|
 * | INSUFFICIENT_FUNDS          | REJECTED | desistir                                  |
 * | REVERSAL_INSUFFICIENT_FUNDS | REJECTED | escalar (reversão deixaria saldo < 0)     |
 * | CURRENCY_MISMATCH           | REJECTED | corrigir payload                          |
 * | WALLET_NOT_FOUND            | REJECTED | corrigir payload                          |
 * | WALLET_PLAYER_MISMATCH      | REJECTED | corrigir payload                          |
 * | REFERENCE_NOT_FOUND         | REJECTED | escalar (referência não chegou no limite) |
 * | REFERENCE_MISMATCH          | REJECTED | corrigir payload                          |
 * | INVALID_REFERENCE_KIND      | REJECTED | corrigir payload                          |
 * | REFERENCE_NOT_PROCESSED     | REJECTED | desistir                                  |
 * | REFERENCE_ALREADY_REVERSED  | REJECTED | desistir                                  |
 * | REVERSAL_AMOUNT_MISMATCH    | REJECTED | corrigir payload                          |
 * | PROCESSING_ERROR            | FAILED   | escalar                                   |
 */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  InvalidReferenceKind = 'INVALID_REFERENCE_KIND',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReversalAmountMismatch = 'REVERSAL_AMOUNT_MISMATCH',
  ProcessingError = 'PROCESSING_ERROR',
}
