import { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface PublishOutcome {
  outboxMessageId: string;
  published: boolean;
  errorMessage?: string;
}

/** Publica eventos de integração no broker. Deve ser idempotente por eventId (= outboxMessageId). */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishOutcome[]>;
}
