import { IntegrationEvent } from '../events/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date | undefined;
  publishedAt?: Date | undefined;
  lastError?: string | undefined;
}

/**
 * Transactional Outbox: o evento é gravado na mesma transação SQL da mudança financeira e
 * publicado depois por um worker. Nunca publica antes do commit; republicação após crash é
 * segura porque o id da mensagem é o eventId (consumidor deduplica por ele).
 */
export class OutboxMessage {
  static readonly RETRY_BASE_DELAY_MS = 1_000;
  static readonly RETRY_MAX_DELAY_MS = 60_000;

  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
    private _lastError: string | undefined,
  ) {}

  /** Enfileira o evento, elegível para publicação imediata. id = eventId. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const serializedEnvelope = event.toJSON() as unknown as Record<string, unknown>;
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      serializedEnvelope,
      event.occurredAt,
      0,
      event.occurredAt,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.lastError,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }
  get lastError(): string | undefined {
    return this._lastError;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(publishedAt: Date): void {
    this._publishedAt = publishedAt;
    this._nextAttemptAt = undefined;
  }

  /** Incrementa attempts e agenda com backoff exponencial: 1s, 2s, 4s... até 60s. */
  scheduleRetry(now: Date, errorMessage?: string): void {
    const exponentialDelayMs = OutboxMessage.RETRY_BASE_DELAY_MS * 2 ** this._attempts;
    const cappedDelayMs = Math.min(exponentialDelayMs, OutboxMessage.RETRY_MAX_DELAY_MS);

    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + cappedDelayMs);
    this._lastError = errorMessage;
  }
}
