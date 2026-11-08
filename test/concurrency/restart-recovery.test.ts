import { SQSClient } from '@aws-sdk/client-sqs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { generateId } from '../../src/domain/shared/identifiers';
import { AppConfig } from '../../src/infrastructure/config/app-config';
import { SqsQueueResolver } from '../../src/infrastructure/messaging/sqs-client';
import { postJson, RunningInstance, startInstances, stopInstances } from '../support/app-instances';
import { createTestOrm } from '../support/test-database';
import { createTestQueues, eventually, sendRawMessage, wagerMessage } from '../support/test-queues';

/**
 * Processo com workers é morto com SIGKILL no meio do consumo (sem shutdown gracioso);
 * três novas instâncias assumem a mesma fila e a mesma outbox. No fim: tudo processado
 * exatamente uma vez, saldo == ledger e outbox drenada.
 */

let orm: MikroORM;
let sqsClient: SQSClient;
let sqsConfig: AppConfig['sqs'];
let runningInstances: RunningInstance[] = [];

beforeAll(async () => {
  orm = await createTestOrm();
  ({ sqsClient, sqsConfig } = await createTestQueues('restart'));
}, 30_000);

afterAll(async () => {
  await stopInstances(runningInstances);
  sqsClient.destroy();
  await orm.close(true);
});

function workerEnvironment(): Record<string, string> {
  return {
    WORKERS_ENABLED: 'true',
    SQS_WAGER_QUEUE_NAME: sqsConfig.wagerQueueName,
    SQS_WAGER_DLQ_NAME: sqsConfig.wagerDlqName,
    SQS_EVENTS_QUEUE_NAME: sqsConfig.eventsQueueName,
    SQS_MAX_RECEIVE_COUNT: String(sqsConfig.maxReceiveCount),
    SQS_RETRY_BASE_DELAY_SECONDS: '1',
    SQS_WAIT_TIME_SECONDS: '1',
  };
}

async function countForWallet(table: string, walletId: string, filter: (query: any) => any = (query) => query): Promise<number> {
  const knex = orm.em.getKnex();
  const [row] = await filter(knex(table).where(table === 'outbox_messages' ? { aggregate_id: walletId } : { wallet_id: walletId })).count('* as count');
  return Number((row as { count: string }).count);
}

describe('reinício com consistência final', () => {
  test('SIGKILL no meio do consumo; 3 instâncias novas terminam o trabalho sem duplicar', async () => {
    const totalBets = 40;
    const [firstInstance] = (runningInstances = await startInstances(1, 3301, workerEnvironment()));

    const playerId = generateId();
    const { body: wallet } = await postJson(`${firstInstance!.baseUrl}/wallets`, {
      playerId,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });
    const walletId = wallet.id as string;

    const queueUrl = await new SqsQueueResolver(sqsClient).urlOf(sqsConfig.wagerQueueName);
    const messages = Array.from({ length: totalBets }, (_, betIndex) =>
      wagerMessage(`msg-${generateId()}`, {
        providerId: 'provider-a',
        externalTransactionId: `restart-${walletId}-${betIndex}`,
        playerId,
        walletId,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '10.00', currency: 'BRL' },
      }),
    );
    for (const message of messages) {
      await sendRawMessage(sqsClient, queueUrl, message, walletId);
    }
    // Redeliveries de 10 mensagens já enviadas.
    for (const message of messages.slice(0, 10)) {
      await sendRawMessage(sqsClient, queueUrl, message, walletId);
    }

    await eventually(async () => (await countForWallet('wager_transactions', walletId, (query) => query.where({ kind: 'BET' }))) >= 5);
    runningInstances[0]!.process.kill('SIGKILL');
    await runningInstances[0]!.process.exited;

    runningInstances = await startInstances(3, 3311, workerEnvironment());

    await eventually(
      async () => (await countForWallet('wager_transactions', walletId, (query) => query.where({ kind: 'BET', status: 'PROCESSED' }))) === totalBets,
      60_000,
    );
    await eventually(
      async () => (await countForWallet('outbox_messages', walletId, (query) => query.whereNull('published_at'))) === 0,
      30_000,
    );

    expect(await countForWallet('wallet_ledger_entries', walletId, (query) => query.where({ direction: 'DEBIT' }))).toBe(totalBets);
    const [inboxRow] = await orm.em
      .getKnex()('inbox_messages')
      .whereIn('message_id', messages.map((message) => message.messageId))
      .count('* as count');
    expect(Number((inboxRow as { count: string }).count)).toBe(totalBets);

    const { body: reconciliation } = await postJson(`${runningInstances[0]!.baseUrl}/wallets/${walletId}/reconciliation`, {});
    expect(reconciliation).toMatchObject({
      consistent: true,
      storedBalance: { amount: '600.00' },
      checkedEntries: totalBets + 1,
    });
  }, 120_000);
});
