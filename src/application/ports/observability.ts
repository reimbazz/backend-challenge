export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** Compatível com pino: objeto de contexto primeiro, mensagem depois. */
export interface StructuredLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export type DuplicateSource = 'idempotency_replay' | 'inbox';

export interface WageringMetrics {
  transactionFinalized(kind: string, status: string): void;
  duplicateDetected(source: DuplicateSource): void;
  lockConflict(): void;
  retry(operation: string): void;
  messageSentToDlq(reason: string): void;
  processingLatency(source: 'http' | 'sqs' | 'worker', seconds: number): void;
  outboxLag(seconds: number): void;
  reconciliationMismatch(): void;
}
