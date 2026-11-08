import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { SubmitWagerTransactionUseCase } from '../../application/wagering/submit-wager-transaction';
import type { WagerTransactionResult } from '../../application/wagering/submit-wager-transaction';
import { WagerTransactionQueries } from '../../application/wagering/wager-transaction-queries';
import { CreateWalletUseCase, WalletQueries } from '../../application/wallets/wallet-use-cases';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import type { AppConfig } from '../../infrastructure/config/app-config';
import { SqsQueueResolver } from '../../infrastructure/messaging/sqs-client';
import { PrometheusWageringMetrics } from '../../infrastructure/observability/prometheus-metrics';
import { correlationIdOf, ProviderAuthGuard } from './http-support';
import { APP_CONFIG, METRICS, ORM, SQS_CLIENT, SQS_QUEUE_RESOLVER } from './tokens';

const DEFAULT_LEDGER_PAGE_SIZE = 50;

@Controller('wallets')
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(WalletQueries) private readonly walletQueries: WalletQueries,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() body: unknown, @Req() request: Request) {
    return this.createWallet.execute(body, correlationIdOf(request));
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.walletQueries.getWallet(walletId);
  }

  @Get(':walletId/ledger')
  ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.walletQueries.getLedgerPage(walletId, cursor, limit === undefined ? DEFAULT_LEDGER_PAGE_SIZE : Number(limit));
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  reconcile(@Param('walletId') walletId: string, @Req() request: Request) {
    return this.walletQueries.reconcile(walletId, correlationIdOf(request));
  }
}

/**
 * Status do resultado de uma submissão (erros de entrada/conflito/infra saem pelo filtro):
 *   200 PROCESSED · 202 PENDING_REFERENCE · 422 REJECTED (failureCode no corpo) · 500 FAILED
 * O mesmo status é devolvido no replay; `idempotentReplay` diferencia.
 */
const HTTP_STATUS_BY_TRANSACTION_STATUS: Record<WagerTransactionStatus, number> = {
  [WagerTransactionStatus.Processed]: HttpStatus.OK,
  [WagerTransactionStatus.PendingReference]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.Pending]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.Rejected]: HttpStatus.UNPROCESSABLE_ENTITY,
  [WagerTransactionStatus.Failed]: HttpStatus.INTERNAL_SERVER_ERROR,
};

@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransactionUseCase) private readonly submitWager: SubmitWagerTransactionUseCase,
    @Inject(WagerTransactionQueries) private readonly transactionQueries: WagerTransactionQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<WagerTransactionResult> {
    const result = await this.submitWager.execute({
      idempotencyKey: idempotencyKey ?? '',
      request: body,
      correlationId: correlationIdOf(request),
      source: 'http',
    });
    response.status(HTTP_STATUS_BY_TRANSACTION_STATUS[result.status]);
    return result;
  }

  @Get('wagering/transactions/:transactionId')
  getById(@Param('transactionId') transactionId: string) {
    return this.transactionQueries.getById(transactionId);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  getByExternalId(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    return this.transactionQueries.getByExternalId(providerId, externalTransactionId);
  }
}

const READINESS_CHECK_TIMEOUT_MS = 2_000;

/** Health e métricas — sem autenticação. */
@Controller()
export class OperationsController {
  constructor(
    @Inject(ORM) private readonly orm: MikroORM,
    @Inject(SQS_CLIENT) private readonly sqsClient: SQSClient,
    @Inject(SQS_QUEUE_RESOLVER) private readonly queueResolver: SqsQueueResolver,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(METRICS) private readonly metrics: PrometheusWageringMetrics,
  ) {}

  /** Processo vivo: não depende de nada externo. */
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** Pronto para tráfego: PostgreSQL e SQS respondem. */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) response: Response) {
    const [postgres, sqs] = await Promise.all([
      checkWithTimeout(() => this.orm.em.getConnection().execute('SELECT 1')),
      checkWithTimeout(async () => {
        const queueUrl = await this.queueResolver.urlOf(this.config.sqs.wagerQueueName);
        await this.sqsClient.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['QueueArn'] }));
      }),
    ]);
    const isReady = postgres === 'up' && sqs === 'up';
    response.status(isReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: isReady ? 'ready' : 'not_ready', checks: { postgres, sqs } };
  }

  @Get('metrics')
  async prometheusMetrics(@Res() response: Response) {
    response.setHeader('Content-Type', this.metrics.registry.contentType);
    response.send(await this.metrics.registry.metrics());
  }
}

async function checkWithTimeout(check: () => Promise<unknown>): Promise<'up' | 'down'> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('timeout')), READINESS_CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([check(), timeout]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timeoutHandle);
  }
}
