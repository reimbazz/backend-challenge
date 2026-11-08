import { createHash } from 'node:crypto';
import { MoneyProps } from '../../domain/money/money';

/** Subconjunto de negócio que define "o mesmo pedido". */
export interface WagerBusinessFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  /** normalizado por Money.toJSON(): "25.0" e "25.00" geram o mesmo hash */
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

/** JSON canônico: chaves ordenadas, sem espaços, campos undefined omitidos. */
export function toCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => toCanonicalJson(item)).join(',')}]`;
  }

  const sortedEntries = Object.entries(value as Record<string, unknown>)
    .filter(([, fieldValue]) => fieldValue !== undefined)
    .sort(([leftKey], [rightKey]) => (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0));

  const serializedFields = sortedEntries.map(
    ([fieldName, fieldValue]) => `${JSON.stringify(fieldName)}:${toCanonicalJson(fieldValue)}`,
  );
  return `{${serializedFields.join(',')}}`;
}

/**
 * payloadHash = SHA-256 (hex) do JSON canônico dos campos de negócio.
 * Header Idempotency-Key e metadados de transporte não entram: HTTP e SQS geram o mesmo hash.
 */
export function computeWagerPayloadHash(businessFields: WagerBusinessFields): string {
  const fieldsToHash: WagerBusinessFields = {
    providerId: businessFields.providerId,
    externalTransactionId: businessFields.externalTransactionId,
    playerId: businessFields.playerId,
    walletId: businessFields.walletId,
    roundId: businessFields.roundId,
    gameId: businessFields.gameId,
    kind: businessFields.kind,
    money: { amount: businessFields.money.amount, currency: businessFields.money.currency },
    referenceExternalTransactionId: businessFields.referenceExternalTransactionId,
  };

  return createHash('sha256').update(toCanonicalJson(fieldsToHash)).digest('hex');
}
