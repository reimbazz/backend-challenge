import { SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { TransientInfrastructureError } from '../../src/application/errors';
import { PublishOutboxUseCase } from '../../src/application/messaging/publish-outbox';
import { EventPublisher } from '../../src/application/ports/event-publisher';
import { UnitOfWork } from '../../src/application/ports/repositories';
import { SubmitWagerTransactionUseCase } from '../../src/application/wagering/submit-wager-transaction';
import { WagerTransactionProcessor } from '../../src/application/wagering/wager-transaction-processor';
import { generateId } from '../../src/domain/shared/identifiers';
import { AppConfig } from '../../src/infrastructure/config/app-config';
import { SqsQueueResolver } from '../../src/infrastructure/messaging/sqs-client';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { SqsWagerConsumer, WAGER_CONSUMER_NAME } from '../../src/interfaces/messaging/sqs-wager-consumer';
import {
  createTestQueues,
  eventually,
  receiveAvailable,
  sendRawMessage,
  wagerMessage,
} from '../support/test-queues';
import {
  countRows,
  createWageringTestKit,
  expectWalletMatchesLedger,
  openWallet,
  silentLogger,
  wagerRequest,
  WageringTestKit,
} from '../support/wagering-test-kit';

let kit: WageringTestKit;
let sqsClient: SQSClient;
let sqsConfig: AppConfig['sqs'];
let queueResolver: SqsQueueResolver;
let wagerQueueUrl: string;
let deadLetterQueueUrl: string;
let eventsQueueUrl: string;

beforeAll(async () => {
  kit = await createWageringTestKit();
  ({ sqsClient, sqsConfig } = await createTestQueues('msg'));
  queueResolver = new SqsQueueResolver(sqsClient);
  wagerQueueUrl = await queueResolver.urlOf(sqsConfig.wagerQueueName);
  deadLetterQueueUrl = await queueResolver.urlOf(sqsConfig.wagerDlqName);
  eventsQueueUrl = await queueResolver.urlOf(sqsConfig.eventsQueueName);
}, 30_000);

afterAll(async () => {
  sqsClient.destroy();
  await kit.orm.close(true);
});

function createConsumer(submitWager: SubmitWagerTransactionUseCase = kit.submitWager): SqsWagerConsumer {
  return new SqsWagerConsumer(sqsClient, queueResolver, sqsConfig, submitWager, kit.metrics, silentLogger);
}

/** Faz polling até a fila principal esvaziar (tudo ackado ou movido para a DLQ). */
async function drainWagerQueue(consumer: SqsWagerConsumer, timeoutMs = 20_000): Promise<void> {
  let emptyPollsInARow = 0;
  await eventually(async () => {
    const receivedSomething = await consumer.pollOnce();
    emptyPollsInARow = receivedSomething ? 0 : emptyPollsInARow + 1;
    return emptyPollsInARow >= 3;
  }, timeoutMs, 0);
}

async function inboxRowsFor(messageId: string): Promise<number> {
  const [row] = await kit.orm.em
    .getKnex()('inbox_messages')
    .where({ consumer_name: WAGER_CONSUMER_NAME, message_id: messageId })
    .count<{ count: string }[]>('* as count');
  return Number(row?.count ?? 0);
}

describe('consumer SQS', () => {
  test('processa a mensagem, registra a inbox e faz ack', async () => {
    const wallet = await openWallet(kit, '100.00');
    const messageId = `msg-${generateId()}`;
    await sendRawMessage(sqsClient, wagerQueueUrl, wagerMessage(messageId, wagerRequest(wallet, { kind: 'BET', amount: '30.00' })), wallet.walletId);

    await drainWagerQueue(createConsumer());

    expect(await inboxRowsFor(messageId)).toBe(1);
    await expectWalletMatchesLedger(kit, wallet.walletId, '70.00');
  });

  test('redelivery do mesmo messageId não duplica o débito', async () => {
    const wallet = await openWallet(kit, '100.00');
    const message = wagerMessage(`msg-${generateId()}`, wagerRequest(wallet, { kind: 'BET', amount: '30.00' }));

    await sendRawMessage(sqsClient, wagerQueueUrl, message, wallet.walletId);
    await sendRawMessage(sqsClient, wagerQueueUrl, message, wallet.walletId);
    await sendRawMessage(sqsClient, wagerQueueUrl, message, wallet.walletId);
    await drainWagerQueue(createConsumer());

    expect(await inboxRowsFor(message.messageId)).toBe(1);
    expect(await countRows(kit, 'wallet_ledger_entries', wallet.walletId, { direction: 'DEBIT' })).toBe(1);
    await expectWalletMatchesLedger(kit, wallet.walletId, '70.00');
  });

  test('worker morto depois do commit e antes do ack: redelivery vira replay, um único débito', async () => {
    const wallet = await openWallet(kit, '100.00');
    const message = wagerMessage(`msg-${generateId()}`, wagerRequest(wallet, { kind: 'BET', amount: '40.00' }));
    await sendRawMessage(sqsClient, wagerQueueUrl, message, wallet.walletId);

    // "Worker" recebe, commita via use case e morre sem fazer DeleteMessage.
    const [receivedMessage] = await receiveAvailable(sqsClient, wagerQueueUrl);
    expect(receivedMessage).toBeDefined();
    const { idempotencyKey, ...request } = message.data;
    await kit.submitWager.execute({
      idempotencyKey,
      request,
      correlationId: message.messageId,
      source: 'sqs',
      inboxMessage: { consumerName: WAGER_CONSUMER_NAME, messageId: message.messageId },
    });

    // Visibility timeout expira, outro consumer recebe a mesma mensagem.
    await drainWagerQueue(createConsumer());

    expect(await countRows(kit, 'wallet_ledger_entries', wallet.walletId, { direction: 'DEBIT' })).toBe(1);
    expect(await inboxRowsFor(message.messageId)).toBe(1);
    await expectWalletMatchesLedger(kit, wallet.walletId, '60.00');
  });

  test('payload inválido vai direto para a DLQ (erro permanente, sem retry)', async () => {
    const wallet = await openWallet(kit, '100.00');
    const invalidMessage = wagerMessage(`msg-${generateId()}`, {
      ...wagerRequest(wallet, { kind: 'BET' }),
      money: { amount: '1e3', currency: 'BRL' },
    });
    await sendRawMessage(sqsClient, wagerQueueUrl, invalidMessage, wallet.walletId);
    await sendRawMessage(sqsClient, wagerQueueUrl, '{ isto não é json', wallet.walletId);

    await drainWagerQueue(createConsumer());

    const deadLetters = await receiveAvailable(sqsClient, deadLetterQueueUrl);
    const reasons = deadLetters.map((message) => message.MessageAttributes?.failureReason?.StringValue);
    expect(reasons).toContain('permanent:INVALID_REQUEST');
    expect(reasons).toContain('permanent:MALFORMED_MESSAGE');
    await expectWalletMatchesLedger(kit, wallet.walletId, '100.00');
  });

  test('falha transitória persistente: retry com backoff até o limite e depois DLQ', async () => {
    const failingUnitOfWork: UnitOfWork = {
      run: () => Promise.reject(new TransientInfrastructureError('banco indisponível (simulado)')),
    };
    const failingSubmit = new SubmitWagerTransactionUseCase(
      failingUnitOfWork,
      new WagerTransactionProcessor(),
      kit.clock,
      kit.metrics,
      silentLogger,
    );
    const wallet = await openWallet(kit, '100.00');
    const message = wagerMessage(`msg-${generateId()}`, wagerRequest(wallet, { kind: 'BET' }));
    await sendRawMessage(sqsClient, wagerQueueUrl, message, wallet.walletId);

    const consumer = createConsumer(failingSubmit);
    let deadLetterBody: string | undefined;
    await eventually(async () => {
      await consumer.pollOnce();
      const [deadLetter] = await receiveAvailable(sqsClient, deadLetterQueueUrl, 0);
      deadLetterBody = deadLetter?.Body;
      return deadLetter?.MessageAttributes?.failureReason?.StringValue === 'retries_exhausted';
    }, 30_000, 0);

    expect(JSON.parse(deadLetterBody!).messageId).toBe(message.messageId);
    await expectWalletMatchesLedger(kit, wallet.walletId, '100.00');
  });
});

describe('outbox publisher', () => {
  /** Envolve o publisher real registrando quem publicou cada eventId. */
  function recordingPublisher(publishedEventIds: string[], afterPublish?: () => void): EventPublisher {
    const realPublisher = new SqsEventPublisher(sqsClient, queueResolver, sqsConfig.eventsQueueName);
    return {
      publish: async (messages) => {
        const outcomes = await realPublisher.publish(messages);
        publishedEventIds.push(...outcomes.filter((outcome) => outcome.published).map((outcome) => outcome.outboxMessageId));
        afterPublish?.();
        return outcomes;
      },
    };
  }

  function publishOutboxWith(publisher: EventPublisher): PublishOutboxUseCase {
    return new PublishOutboxUseCase(kit.unitOfWork, publisher, kit.clock, kit.metrics, silentLogger);
  }

  /** Pendentes já devidos (outros testes criam eventos com relógio adiantado, ainda não devidos). */
  async function pendingOutboxCount(): Promise<number> {
    const [row] = await kit.orm.em
      .getKnex()('outbox_messages')
      .whereNull('published_at')
      .where('next_attempt_at', '<=', kit.clock.now())
      .count<{ count: string }[]>('* as count');
    return Number(row?.count ?? 0);
  }

  async function drainOutbox(publisher: PublishOutboxUseCase): Promise<void> {
    while ((await publisher.runOnce(50)) > 0) {
      // continua até não haver eventos devidos
    }
  }

  test('dois publishers concorrentes na mesma outbox nunca publicam o mesmo evento', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet(kit, '100.00')));
    for (const wallet of wallets) {
      await kit.submitWager.execute({
        idempotencyKey: generateId(),
        request: wagerRequest(wallet, { kind: 'BET', amount: '1.00' }),
        correlationId: 'test',
        source: 'http',
      });
    }

    const eventsByPublisherA: string[] = [];
    const eventsByPublisherB: string[] = [];
    const publisherA = publishOutboxWith(recordingPublisher(eventsByPublisherA));
    const publisherB = publishOutboxWith(recordingPublisher(eventsByPublisherB));

    await Promise.all([drainOutbox(publisherA), drainOutbox(publisherB), drainOutbox(publisherA), drainOutbox(publisherB)]);

    const publishedByBoth = eventsByPublisherA.filter((eventId) => eventsByPublisherB.includes(eventId));
    expect(publishedByBoth).toEqual([]);
    expect(new Set(eventsByPublisherA).size).toBe(eventsByPublisherA.length);
    expect(new Set(eventsByPublisherB).size).toBe(eventsByPublisherB.length);
    expect(eventsByPublisherA.length + eventsByPublisherB.length).toBeGreaterThan(0);
    expect(await pendingOutboxCount()).toBe(0);
  }, 60_000);

  test('crash depois de publicar e antes do commit: outra instância republica o mesmo eventId', async () => {
    await drainOutbox(publishOutboxWith(recordingPublisher([])));

    const wallet = await openWallet(kit, '100.00');
    await kit.submitWager.execute({
      idempotencyKey: generateId(),
      request: wagerRequest(wallet, { kind: 'BET', amount: '5.00' }),
      correlationId: 'test',
      source: 'http',
    });

    const eventsPublishedBeforeCrash: string[] = [];
    const crashingPublisher = publishOutboxWith(
      recordingPublisher(eventsPublishedBeforeCrash, () => {
        throw new Error('processo morreu antes do commit (simulado)');
      }),
    );
    await expect(crashingPublisher.runOnce(50)).rejects.toThrow('processo morreu');
    expect(eventsPublishedBeforeCrash.length).toBeGreaterThan(0);
    expect(await pendingOutboxCount()).toBeGreaterThan(0);

    const eventsRepublished: string[] = [];
    await drainOutbox(publishOutboxWith(recordingPublisher(eventsRepublished)));

    expect(eventsRepublished.sort()).toEqual(eventsPublishedBeforeCrash.sort());
    expect(await pendingOutboxCount()).toBe(0);

    // Mesmo eventId = mesmo MessageDeduplicationId: a fila FIFO entrega cada evento uma vez.
    const deliveredEventIds: string[] = [];
    for (let receiveRound = 0; receiveRound < 5; receiveRound++) {
      const messages = await receiveAvailable(sqsClient, eventsQueueUrl, 0);
      if (messages.length === 0) break;
      deliveredEventIds.push(...messages.map((message) => (JSON.parse(message.Body ?? '{}') as { eventId: string }).eventId));
    }
    const deliveredFromThisScenario = deliveredEventIds.filter((eventId) => eventsPublishedBeforeCrash.includes(eventId));
    expect(new Set(deliveredFromThisScenario).size).toBe(deliveredFromThisScenario.length);
  }, 60_000);
});
