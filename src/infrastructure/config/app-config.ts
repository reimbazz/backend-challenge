/** Configuração lida do ambiente, com defaults para desenvolvimento local. */
export interface AppConfig {
  instanceName: string;
  httpPort: number;
  workersEnabled: boolean;
  database: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
    poolMax: number;
  };
  sqs: {
    region: string;
    endpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    wagerQueueName: string;
    wagerDlqName: string;
    eventsQueueName: string;
    maxReceiveCount: number;
  };
}

function readString(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function readNumber(name: string, fallback: number): number {
  const rawValue = process.env[name];
  const parsedValue = rawValue === undefined ? fallback : Number(rawValue);
  if (!Number.isFinite(parsedValue)) {
    throw new Error(`Variável de ambiente ${name} deve ser numérica`);
  }
  return parsedValue;
}

export function loadAppConfig(): AppConfig {
  return {
    instanceName: readString('INSTANCE_NAME', 'local-1'),
    httpPort: readNumber('HTTP_PORT', 3000),
    workersEnabled: readString('WORKERS_ENABLED', 'true') === 'true',
    database: {
      host: readString('DATABASE_HOST', 'localhost'),
      port: readNumber('DATABASE_PORT', 5433),
      name: readString('DATABASE_NAME', 'wagering'),
      user: readString('DATABASE_USER', 'wagering'),
      password: readString('DATABASE_PASSWORD', 'wagering'),
      poolMax: readNumber('DATABASE_POOL_MAX', 20),
    },
    sqs: {
      region: readString('AWS_REGION', 'us-east-1'),
      endpoint: readString('SQS_ENDPOINT', 'http://localhost:4566'),
      accessKeyId: readString('AWS_ACCESS_KEY_ID', 'test'),
      secretAccessKey: readString('AWS_SECRET_ACCESS_KEY', 'test'),
      wagerQueueName: readString('SQS_WAGER_QUEUE_NAME', 'wager-transactions.fifo'),
      wagerDlqName: readString('SQS_WAGER_DLQ_NAME', 'wager-transactions-dlq.fifo'),
      eventsQueueName: readString('SQS_EVENTS_QUEUE_NAME', 'wagering-events.fifo'),
      maxReceiveCount: readNumber('SQS_MAX_RECEIVE_COUNT', 5),
    },
  };
}
