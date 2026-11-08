import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { EventPublisher, PublishOutcome } from '../../application/ports/event-publisher';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import { SqsQueueResolver } from './sqs-client';

const SQS_BATCH_LIMIT = 10;

/**
 * Publica na fila FIFO de eventos:
 *   MessageGroupId = aggregateId (walletId) → ordem preservada por wallet;
 *   MessageDeduplicationId = eventId → republicação dentro de 5 min é descartada pelo SQS.
 */
export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly sqsClient: SQSClient,
    private readonly queueResolver: SqsQueueResolver,
    private readonly eventsQueueName: string,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishOutcome[]> {
    const outcomes: PublishOutcome[] = [];
    let queueUrl: string;
    try {
      queueUrl = await this.queueResolver.urlOf(this.eventsQueueName);
    } catch (error) {
      return messages.map((message) => ({ outboxMessageId: message.id, published: false, errorMessage: (error as Error).message }));
    }

    for (let offset = 0; offset < messages.length; offset += SQS_BATCH_LIMIT) {
      const batch = messages.slice(offset, offset + SQS_BATCH_LIMIT);
      try {
        const response = await this.sqsClient.send(
          new SendMessageBatchCommand({
            QueueUrl: queueUrl,
            Entries: batch.map((message, index) => ({
              Id: String(index),
              MessageBody: JSON.stringify(message.payload),
              MessageGroupId: message.aggregateId,
              MessageDeduplicationId: message.id,
              MessageAttributes: { eventType: { DataType: 'String', StringValue: message.eventType } },
            })),
          }),
        );
        const failedEntryIndexes = new Map((response.Failed ?? []).map((failure) => [failure.Id, failure.Message]));
        batch.forEach((message, index) => {
          const failureMessage = failedEntryIndexes.get(String(index));
          outcomes.push(
            failedEntryIndexes.has(String(index))
              ? { outboxMessageId: message.id, published: false, errorMessage: failureMessage ?? 'falha no batch' }
              : { outboxMessageId: message.id, published: true },
          );
        });
      } catch (error) {
        batch.forEach((message) =>
          outcomes.push({ outboxMessageId: message.id, published: false, errorMessage: (error as Error).message }),
        );
      }
    }
    return outcomes;
  }
}
