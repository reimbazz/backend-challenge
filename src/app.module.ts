import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { DynamicModule, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import type { Logger } from 'pino';
import { systemClock } from './application/ports/observability';
import type { Clock, StructuredLogger, WageringMetrics } from './application/ports/observability';
import type { UnitOfWork } from './application/ports/repositories';
import { ResolvePendingReferencesUseCase } from './application/wagering/resolve-pending-references';
import { SubmitWagerTransactionUseCase } from './application/wagering/submit-wager-transaction';
import { WagerTransactionProcessor } from './application/wagering/wager-transaction-processor';
import { WagerTransactionQueries } from './application/wagering/wager-transaction-queries';
import { CreateWalletUseCase, WalletQueries } from './application/wallets/wallet-use-cases';
import type { AppConfig } from './infrastructure/config/app-config';
import { createSqsClient, SqsQueueResolver } from './infrastructure/messaging/sqs-client';
import { asStructuredLogger } from './infrastructure/observability/logger';
import { PrometheusWageringMetrics } from './infrastructure/observability/prometheus-metrics';
import { buildMikroOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work';
import { OperationsController, WageringController, WalletsController } from './interfaces/http/controllers';
import { ProviderAuthGuard } from './interfaces/http/http-support';
import {
  APP_CONFIG,
  CLOCK,
  METRICS,
  ORM,
  ROOT_LOGGER,
  SQS_CLIENT,
  SQS_QUEUE_RESOLVER,
  STRUCTURED_LOGGER,
  UNIT_OF_WORK,
} from './interfaces/http/tokens';

/** Fecha conexões no shutdown (pool do Postgres e cliente SQS). */
class InfrastructureLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqsClient: SQSClient,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.sqsClient.destroy();
    await this.orm.close();
  }
}

/**
 * Composition root: o único lugar que conhece as implementações concretas.
 * Use cases são classes puras montadas por factory — não dependem do NestJS.
 */
@Module({})
export class AppModule {
  static register(config: AppConfig, rootLogger: Logger): DynamicModule {
    return {
      module: AppModule,
      controllers: [WalletsController, WageringController, OperationsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: ROOT_LOGGER, useValue: rootLogger },
        { provide: STRUCTURED_LOGGER, useValue: asStructuredLogger(rootLogger) },
        { provide: CLOCK, useValue: systemClock },
        { provide: METRICS, useValue: new PrometheusWageringMetrics({ collectDefaults: true }) },
        { provide: ORM, useFactory: () => MikroORM.init(buildMikroOrmConfig(config.database)) },
        { provide: SQS_CLIENT, useFactory: () => createSqsClient(config.sqs) },
        {
          provide: SQS_QUEUE_RESOLVER,
          useFactory: (sqsClient: SQSClient) => new SqsQueueResolver(sqsClient),
          inject: [SQS_CLIENT],
        },
        {
          provide: UNIT_OF_WORK,
          useFactory: (orm: MikroORM, metrics: WageringMetrics) => new MikroOrmUnitOfWork(orm, metrics),
          inject: [ORM, METRICS],
        },
        { provide: WagerTransactionProcessor, useValue: new WagerTransactionProcessor() },
        {
          provide: SubmitWagerTransactionUseCase,
          useFactory: (
            unitOfWork: UnitOfWork,
            processor: WagerTransactionProcessor,
            clock: Clock,
            metrics: WageringMetrics,
            logger: StructuredLogger,
          ) => new SubmitWagerTransactionUseCase(unitOfWork, processor, clock, metrics, logger),
          inject: [UNIT_OF_WORK, WagerTransactionProcessor, CLOCK, METRICS, STRUCTURED_LOGGER],
        },
        {
          provide: ResolvePendingReferencesUseCase,
          useFactory: (
            unitOfWork: UnitOfWork,
            processor: WagerTransactionProcessor,
            clock: Clock,
            metrics: WageringMetrics,
            logger: StructuredLogger,
          ) => new ResolvePendingReferencesUseCase(unitOfWork, processor, clock, metrics, logger),
          inject: [UNIT_OF_WORK, WagerTransactionProcessor, CLOCK, METRICS, STRUCTURED_LOGGER],
        },
        {
          provide: CreateWalletUseCase,
          useFactory: (unitOfWork: UnitOfWork, clock: Clock) => new CreateWalletUseCase(unitOfWork, clock),
          inject: [UNIT_OF_WORK, CLOCK],
        },
        {
          provide: WalletQueries,
          useFactory: (unitOfWork: UnitOfWork, metrics: WageringMetrics, logger: StructuredLogger) =>
            new WalletQueries(unitOfWork, metrics, logger),
          inject: [UNIT_OF_WORK, METRICS, STRUCTURED_LOGGER],
        },
        {
          provide: WagerTransactionQueries,
          useFactory: (unitOfWork: UnitOfWork) => new WagerTransactionQueries(unitOfWork),
          inject: [UNIT_OF_WORK],
        },
        ProviderAuthGuard,
        InfrastructureLifecycle,
      ],
    };
  }
}
