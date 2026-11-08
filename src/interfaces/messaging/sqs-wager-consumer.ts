import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { z } from 'zod';
import {
  IdempotencyConflictError,
  InvalidRequestError,
  InvariantViolationError,
} from '../../application/errors';
import { StructuredLogger, WageringMetrics } from '../../application/ports/observability';
import { SubmitWagerTransactionUseCase } from '../../application/wagering/submit-wager-transaction';
import type { AppConfig } from '../../infrastructure/config/app-config';
import { SqsQueueResolver } from '../../infrastructure/messaging/sqs-client';

export const WAGER_CONSUMER_NAME = 'wager-transactions-consumer';

const MAX_VISIBILITY_BACKOFF_SECONDS = 300;

const wagerMessageEnvelopeSchema = z.object({
  messageId: z.string().min(1).max(256),
  type: z.literal('WagerTransactionRequested'),
  occurredAt: z.string(),
  correlationId: z.string().max(128).optional(),
  data: z.object({ idempotencyKey: z.string().min(1).max(512) }).passthrough(),
});

class MalformedMessageError extends Error {
  readonly code = 'MALFORMED_MESSAGE';
}

type FailureKind = 'permanent' | 'transient';

/**
 * Erros de negócio não chegam aqui: viram REJECTED/PENDING_REFERENCE commitados → ack.
 * Payload inválido, conflito de idempotência e violação de invariante não melhoram com retry → DLQ.
 * Qualquer outra coisa é tratada como transitória → retry com backoff até o limite → DLQ.
 */
function classifyFailure(error: unknown): FailureKind {
  if (
    error instanceof MalformedMessageError ||
    error instanceof InvalidRequestError ||
    error instanceof IdempotencyConflictError ||
    error instanceof InvariantViolationError
  ) {
    return 'permanent';
  }
  return 'transient';
}

/**
 * Consumidor da fila wager-transactions.fifo.
 *
 * - Reutiliza o mesmo use case da entrada HTTP; deduplica pela inbox persistente
 *   (consumerName, messageId) gravada na mesma transação SQL do efeito.
 * - Ack (DeleteMessage) só depois que o use case retornou, ou seja, depois do commit.
 *   Morrer entre o commit e o ack causa redelivery, que vira replay idempotente.
 * - Mensagens do mesmo MessageGroupId são processadas em ordem; grupos diferentes em paralelo.
 * - stop(): para de receber, conclui as mensagens em andamento e devolve a visibilidade
 *   (timeout 0) das que ainda não começaram.
 */
export class SqsWagerConsumer {
  private stopping = false;
  private receiveAbortController = new AbortController();

  constructor(
    private readonly sqsClient: SQSClient,
    private readonly queueResolver: SqsQueueResolver,
    private readonly sqsConfig: AppConfig['sqs'],
    private readonly submitWager: SubmitWagerTransactionUseCase,
    private readonly metrics: WageringMetrics,
    private readonly logger: StructuredLogger,
  ) {}

  /** Uma rodada de long polling. @returns true se recebeu mensagens */
  async pollOnce(): Promise<boolean> {
    if (this.stopping) return false;
    const queueUrl = await this.queueResolver.urlOf(this.sqsConfig.wagerQueueName);

    let receivedMessages: Message[];
    try {
      const response = await this.sqsClient.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: this.sqsConfig.waitTimeSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        }),
        { abortSignal: this.receiveAbortController.signal },
      );
      receivedMessages = response.Messages ?? [];
    } catch (error) {
      if (this.stopping) return false;
      throw error;
    }
    if (receivedMessages.length === 0) return false;

    const messagesByGroup = new Map<string, Message[]>();
    for (const message of receivedMessages) {
      const groupId = message.Attributes?.MessageGroupId ?? 'default';
      messagesByGroup.set(groupId, [...(messagesByGroup.get(groupId) ?? []), message]);
    }

    await Promise.all(
      [...messagesByGroup.values()].map(async (groupMessages) => {
        for (const message of groupMessages) {
          if (this.stopping) {
            await this.releaseMessage(queueUrl, message);
          } else {
            await this.handleMessage(queueUrl, message);
          }
        }
      }),
    );
    return true;
  }

  /** Sinaliza parada e cancela o long polling em curso. */
  requestStop(): void {
    this.stopping = true;
    this.receiveAbortController.abort();
  }

  private async handleMessage(queueUrl: string, message: Message): Promise<void> {
    const startedAt = performance.now();
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    let messageId = message.MessageId ?? 'unknown';

    try {
      const envelope = this.parseEnvelope(message.Body);
      messageId = envelope.messageId;
      const { idempotencyKey, ...request } = envelope.data;

      const result = await this.submitWager.execute({
        idempotencyKey,
        request,
        correlationId: envelope.correlationId ?? envelope.messageId,
        source: 'sqs',
        inboxMessage: { consumerName: WAGER_CONSUMER_NAME, messageId: envelope.messageId },
      });

      // Commit já aconteceu dentro de execute(); só agora confirmamos ao broker.
      await this.acknowledge(queueUrl, message);
      this.logger.info(
        {
          correlationId: envelope.correlationId ?? envelope.messageId,
          messageId,
          transactionId: result.transactionId,
          walletId: String(request['walletId'] ?? ''),
          providerId: String(request['providerId'] ?? ''),
          status: result.status,
          idempotentReplay: result.idempotentReplay,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'mensagem SQS processada',
      );
    } catch (error) {
      await this.handleFailure(queueUrl, message, messageId, receiveCount, error);
    }
  }

  private async handleFailure(
    queueUrl: string,
    message: Message,
    messageId: string,
    receiveCount: number,
    error: unknown,
  ): Promise<void> {
    const failureKind = classifyFailure(error);
    const reason = (error as { code?: string }).code ?? (error as Error).name ?? 'unknown';

    if (failureKind === 'permanent') {
      await this.sendToDeadLetterQueue(queueUrl, message, messageId, `permanent:${reason}`, error);
      return;
    }
    if (receiveCount >= this.sqsConfig.maxReceiveCount) {
      await this.sendToDeadLetterQueue(queueUrl, message, messageId, 'retries_exhausted', error);
      return;
    }

    const visibilityDelaySeconds = Math.min(
      this.sqsConfig.retryBaseDelaySeconds * 2 ** (receiveCount - 1),
      MAX_VISIBILITY_BACKOFF_SECONDS,
    );
    this.metrics.retry('sqs_message');
    this.logger.warn(
      { messageId, receiveCount, visibilityDelaySeconds, reason: (error as Error).message },
      'falha transitória; mensagem volta para a fila com backoff',
    );
    await this.changeVisibility(queueUrl, message, visibilityDelaySeconds);
  }

  /**
   * Move explicitamente para a DLQ (com o motivo) e remove da fila principal.
   * O RedrivePolicy da fila continua como rede de segurança caso o processo morra antes disso.
   */
  private async sendToDeadLetterQueue(
    queueUrl: string,
    message: Message,
    messageId: string,
    reason: string,
    error: unknown,
  ): Promise<void> {
    const deadLetterQueueUrl = await this.queueResolver.urlOf(this.sqsConfig.wagerDlqName);
    await this.sqsClient.send(
      new SendMessageCommand({
        QueueUrl: deadLetterQueueUrl,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          failureReason: { DataType: 'String', StringValue: reason },
          failureMessage: { DataType: 'String', StringValue: ((error as Error).message ?? 'unknown').slice(0, 512) },
        },
      }),
    );
    await this.acknowledge(queueUrl, message);
    this.metrics.messageSentToDlq(reason.split(':')[0] ?? reason);
    this.logger.error({ messageId, reason, errorMessage: (error as Error).message }, 'mensagem enviada para a DLQ');
  }

  private async acknowledge(queueUrl: string, message: Message): Promise<void> {
    await this.sqsClient.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  /** Devolve a mensagem para a fila imediatamente (shutdown). */
  private async releaseMessage(queueUrl: string, message: Message): Promise<void> {
    await this.changeVisibility(queueUrl, message, 0);
  }

  private async changeVisibility(queueUrl: string, message: Message, visibilityTimeoutSeconds: number): Promise<void> {
    try {
      await this.sqsClient.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: visibilityTimeoutSeconds,
        }),
      );
    } catch (error) {
      // Sem sucesso aqui, a mensagem reaparece ao fim do visibility timeout padrão — nada se perde.
      this.logger.warn({ messageId: message.MessageId, reason: (error as Error).message }, 'falha ao alterar visibilidade');
    }
  }

  private parseEnvelope(body: string | undefined) {
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body ?? '');
    } catch {
      throw new MalformedMessageError('corpo da mensagem não é JSON');
    }
    const envelope = wagerMessageEnvelopeSchema.safeParse(parsedBody);
    if (!envelope.success) {
      throw new MalformedMessageError(`envelope inválido: ${envelope.error.message}`);
    }
    return envelope.data;
  }
}
