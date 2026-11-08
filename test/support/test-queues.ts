import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { AppConfig, loadAppConfig } from '../../src/infrastructure/config/app-config';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs-client';

export const TEST_MAX_RECEIVE_COUNT = 3;

/**
 * Cria filas FIFO exclusivas para um arquivo de teste (LocalStack real), com visibility
 * timeout curto para os cenários de redelivery não demorarem.
 */
export async function createTestQueues(prefix: string): Promise<{ sqsClient: SQSClient; sqsConfig: AppConfig['sqs'] }> {
  const baseConfig = loadAppConfig().sqs;
  const sqsClient = createSqsClient(baseConfig);
  const uniquePrefix = `${prefix}-${Date.now().toString(36)}`;

  const deadLetterQueueName = `${uniquePrefix}-dlq.fifo`;
  const wagerQueueName = `${uniquePrefix}.fifo`;
  const eventsQueueName = `${uniquePrefix}-events.fifo`;

  const { QueueUrl: deadLetterQueueUrl } = await sqsClient.send(
    new CreateQueueCommand({ QueueName: deadLetterQueueName, Attributes: { FifoQueue: 'true' } }),
  );
  const { Attributes } = await sqsClient.send(
    new GetQueueAttributesCommand({ QueueUrl: deadLetterQueueUrl, AttributeNames: ['QueueArn'] }),
  );
  await sqsClient.send(
    new CreateQueueCommand({
      QueueName: wagerQueueName,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: '2',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes?.QueueArn, maxReceiveCount: String(TEST_MAX_RECEIVE_COUNT) }),
      },
    }),
  );
  await sqsClient.send(new CreateQueueCommand({ QueueName: eventsQueueName, Attributes: { FifoQueue: 'true' } }));

  return {
    sqsClient,
    sqsConfig: {
      ...baseConfig,
      wagerQueueName,
      wagerDlqName: deadLetterQueueName,
      eventsQueueName,
      maxReceiveCount: TEST_MAX_RECEIVE_COUNT,
      retryBaseDelaySeconds: 1,
      waitTimeSeconds: 1,
    },
  };
}

/** Envelope da seção 10. */
export function wagerMessage(messageId: string, data: Record<string, unknown>) {
  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { idempotencyKey: `${data.providerId}:${data.externalTransactionId}`, ...data },
  };
}

/** Envia com deduplicação aleatória — permite simular redelivery do mesmo messageId. */
export async function sendRawMessage(sqsClient: SQSClient, queueUrl: string, body: unknown, groupId: string): Promise<void> {
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: crypto.randomUUID(),
    }),
  );
}

/** Lê (e deixa invisível) as mensagens disponíveis numa fila. */
export async function receiveAvailable(sqsClient: SQSClient, queueUrl: string, waitTimeSeconds = 1): Promise<Message[]> {
  const { Messages } = await sqsClient.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: waitTimeSeconds,
      MessageAttributeNames: ['All'],
      MessageSystemAttributeNames: ['ApproximateReceiveCount'],
    }),
  );
  return Messages ?? [];
}

/** Repete `check` até retornar true ou estourar o prazo. */
export async function eventually(check: () => Promise<boolean>, timeoutMs = 20_000, intervalMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error(`condição não satisfeita em ${timeoutMs}ms`);
}
