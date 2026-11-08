import { BeforeApplicationShutdown, Inject, OnApplicationBootstrap } from '@nestjs/common';
import { PublishOutboxUseCase } from '../../application/messaging/publish-outbox';
import type { StructuredLogger } from '../../application/ports/observability';
import { ResolvePendingReferencesUseCase } from '../../application/wagering/resolve-pending-references';
import type { AppConfig } from '../../infrastructure/config/app-config';
import { APP_CONFIG, STRUCTURED_LOGGER } from '../http/tokens';
import { SqsWagerConsumer } from '../messaging/sqs-wager-consumer';

const OUTBOX_IDLE_DELAY_MS = 500;
const PENDING_REFERENCES_IDLE_DELAY_MS = 1_000;
const ERROR_BACKOFF_MS = 2_000;

/**
 * Laço de polling com parada cooperativa: `stop()` interrompe a espera ociosa e aguarda
 * a iteração em andamento terminar (nunca corta uma transação no meio).
 */
export class PollingLoop {
  private running = false;
  private loopCompletion: Promise<void> = Promise.resolve();
  private wakeUpSleep: (() => void) | undefined;

  constructor(
    readonly name: string,
    private readonly iteration: () => Promise<boolean>,
    private readonly idleDelayMs: number,
    private readonly logger: StructuredLogger,
    private readonly onStopRequested?: () => void,
  ) {}

  start(): void {
    this.running = true;
    this.loopCompletion = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.onStopRequested?.();
    this.wakeUpSleep?.();
    await this.loopCompletion;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let delayMs = 0;
      try {
        const didWork = await this.iteration();
        delayMs = didWork ? 0 : this.idleDelayMs;
      } catch (error) {
        this.logger.error({ worker: this.name, reason: (error as Error).message }, 'falha no worker');
        delayMs = ERROR_BACKOFF_MS;
      }
      if (delayMs > 0 && this.running) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          this.wakeUpSleep = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
    }
  }
}

/**
 * Sobe os workers no bootstrap (se WORKERS_ENABLED) e os para antes do shutdown da aplicação
 * (SIGTERM via enableShutdownHooks) — o pool do banco só fecha depois disso.
 */
export class BackgroundWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly loops: PollingLoop[] = [];

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SqsWagerConsumer) private readonly consumer: SqsWagerConsumer,
    @Inject(PublishOutboxUseCase) private readonly publishOutbox: PublishOutboxUseCase,
    @Inject(ResolvePendingReferencesUseCase) private readonly resolvePendingReferences: ResolvePendingReferencesUseCase,
    @Inject(STRUCTURED_LOGGER) private readonly logger: StructuredLogger,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.workersEnabled) return;

    this.loops.push(
      new PollingLoop('sqs-wager-consumer', () => this.consumer.pollOnce(), 0, this.logger, () => this.consumer.requestStop()),
      new PollingLoop('outbox-publisher', async () => (await this.publishOutbox.runOnce()) > 0, OUTBOX_IDLE_DELAY_MS, this.logger),
      new PollingLoop(
        'pending-references',
        async () => (await this.resolvePendingReferences.runOnce()) > 0,
        PENDING_REFERENCES_IDLE_DELAY_MS,
        this.logger,
      ),
    );
    for (const loop of this.loops) loop.start();
    this.logger.info({ workers: this.loops.map((loop) => loop.name) }, 'workers iniciados');
  }

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info({ signal }, 'parando workers');
    await Promise.all(this.loops.map((loop) => loop.stop()));
    this.logger.info({ signal }, 'workers parados');
  }
}
