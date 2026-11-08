import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { AppConfig } from '../config/app-config';

export function createSqsClient(sqsConfig: AppConfig['sqs']): SQSClient {
  return new SQSClient({
    region: sqsConfig.region,
    endpoint: sqsConfig.endpoint,
    credentials: { accessKeyId: sqsConfig.accessKeyId, secretAccessKey: sqsConfig.secretAccessKey },
  });
}

/** Resolve e memoriza URLs de fila pelo nome. */
export class SqsQueueResolver {
  private readonly queueUrlsByName = new Map<string, string>();

  constructor(private readonly sqsClient: SQSClient) {}

  async urlOf(queueName: string): Promise<string> {
    const cachedUrl = this.queueUrlsByName.get(queueName);
    if (cachedUrl) return cachedUrl;

    const { QueueUrl: queueUrl } = await this.sqsClient.send(new GetQueueUrlCommand({ QueueName: queueName }));
    if (!queueUrl) {
      throw new Error(`fila SQS não encontrada: ${queueName}`);
    }
    this.queueUrlsByName.set(queueName, queueUrl);
    return queueUrl;
  }
}
