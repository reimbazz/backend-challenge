import { z } from 'zod';
import { InboxMessage } from '../../domain/messaging/inbox-message';
import { Money, MoneyProps } from '../../domain/money/money';
import { DomainError } from '../../domain/shared/domain-error';
import { generateId } from '../../domain/shared/identifiers';
import {
  EXTERNAL_WAGER_KINDS,
  WagerTransaction,
  WagerTransactionStatus,
} from '../../domain/wagering/wager-transaction';
import {
  IdempotencyConflictError,
  InvalidRequestError,
  TransientInfrastructureError,
  UniqueConstraintConflictError,
} from '../errors';
import { Clock, StructuredLogger, WageringMetrics } from '../ports/observability';
import { TransactionalContext, UnitOfWork } from '../ports/repositories';
import { computeWagerPayloadHash } from './payload-hash';
import { WagerTransactionProcessor } from './wager-transaction-processor';

/** Contrato de entrada comum a HTTP e SQS. */
export const wagerRequestSchema = z.object({
  providerId: z.string().min(1).max(128),
  externalTransactionId: z.string().min(1).max(256),
  playerId: z.string().min(1).max(128),
  walletId: z.string().uuid(),
  roundId: z.string().min(1).max(256),
  gameId: z.string().min(1).max(256),
  kind: z.enum(EXTERNAL_WAGER_KINDS),
  money: z.object({ amount: z.string(), currency: z.string() }).strict(),
  referenceExternalTransactionId: z.string().min(1).max(256).optional(),
});

export type WagerRequest = z.infer<typeof wagerRequestSchema>;

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  request: unknown;
  correlationId: string;
  source: 'http' | 'sqs';
  /** presente quando a entrada é SQS: deduplicação persistente por (consumerName, messageId) */
  inboxMessage?: { consumerName: string; messageId: string };
}

export interface WagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: string;
  idempotentReplay: boolean;
}

/** Uma colisão de unicidade numa corrida resolve-se relendo; mais que isso indica outro problema. */
const MAX_ATTEMPTS = 3;

/**
 * Submissão de transação de aposta — mesmo use case para HTTP e SQS.
 *
 * Concorrência: a wallet é travada com SELECT ... FOR UPDATE antes de qualquer decisão;
 * operações da mesma wallet serializam entre instâncias, wallets diferentes seguem em paralelo.
 *
 * Idempotência: a idempotency key é verificada antes e depois do lock; UNIQUE(provider, key)
 * no banco é a garantia final — uma corrida que bata nela é repetida e vira replay.
 */
export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly processor: WagerTransactionProcessor,
    private readonly clock: Clock,
    private readonly metrics: WageringMetrics,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * @throws InvalidRequestError payload inválido (schema, Money, regra estrutural)
   * @throws IdempotencyConflictError mesma key/externalId com payload diferente
   * @throws TransientInfrastructureError banco indisponível, lock timeout, conflitos persistentes
   */
  async execute(command: SubmitWagerTransactionCommand): Promise<WagerTransactionResult> {
    const startedAt = performance.now();
    const request = this.parseRequest(command);
    const money = this.parseMoney(request.money);
    const payloadHash = computeWagerPayloadHash({ ...request, money: money.toJSON() });

    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.unitOfWork.run((context) =>
          this.processInTransaction(context, command, request, money, payloadHash),
        );
        this.recordOutcome(command, request, result, startedAt);
        return result;
      } catch (error) {
        const canRetry =
          attempt < MAX_ATTEMPTS &&
          (error instanceof UniqueConstraintConflictError || error instanceof TransientInfrastructureError);
        if (!canRetry) {
          throw error instanceof UniqueConstraintConflictError
            ? new TransientInfrastructureError('conflito de unicidade persistente', error)
            : error;
        }
        this.metrics.retry('submit_wager_transaction');
        this.logger.warn(
          { correlationId: command.correlationId, providerId: request.providerId, walletId: request.walletId, attempt, reason: (error as Error).message },
          'nova tentativa de submissão',
        );
      }
    }
  }

  private async processInTransaction(
    context: TransactionalContext,
    command: SubmitWagerTransactionCommand,
    request: WagerRequest,
    money: Money,
    payloadHash: string,
  ): Promise<WagerTransactionResult> {
    const now = this.clock.now();

    const inboxAlreadyRecorded = command.inboxMessage
      ? (await context.inbox.find(command.inboxMessage.consumerName, command.inboxMessage.messageId)) !== null
      : false;
    if (inboxAlreadyRecorded) {
      this.metrics.duplicateDetected('inbox');
    }

    // Caminho rápido para replay, sem lock.
    const existingBeforeLock = await context.transactions.findByIdempotencyKey(request.providerId, command.idempotencyKey);
    if (existingBeforeLock) {
      return this.replayOrConflict(context, command, existingBeforeLock, payloadHash, now, inboxAlreadyRecorded);
    }

    const wallet = await context.wallets.findByIdForUpdate(request.walletId);

    // Revalida após o lock: outra instância pode ter commitado enquanto esperávamos.
    const existingAfterLock = await context.transactions.findByIdempotencyKey(request.providerId, command.idempotencyKey);
    if (existingAfterLock) {
      return this.replayOrConflict(context, command, existingAfterLock, payloadHash, now, inboxAlreadyRecorded);
    }

    const sameExternalId = await context.transactions.findByExternalId(request.providerId, request.externalTransactionId);
    if (sameExternalId) {
      throw new IdempotencyConflictError(
        `externalTransactionId ${request.externalTransactionId} já registrado com outra idempotency key`,
        sameExternalId.id,
      );
    }

    const transaction = this.buildTransaction(command, request, money, payloadHash, now);
    context.transactions.add(transaction, { correlationId: command.correlationId });
    this.registerInbox(context, command, payloadHash, now, inboxAlreadyRecorded);

    await this.processor.apply(context, transaction, wallet, now, {
      correlationId: command.correlationId,
      causationId: command.inboxMessage?.messageId,
      occurredAt: now,
    });

    return toResult(transaction, false);
  }

  /** Regra 7: repetição devolve o resultado original; payload diferente é conflito. */
  private replayOrConflict(
    context: TransactionalContext,
    command: SubmitWagerTransactionCommand,
    existing: WagerTransaction,
    payloadHash: string,
    now: Date,
    inboxAlreadyRecorded: boolean,
  ): WagerTransactionResult {
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(
        `idempotency key ${command.idempotencyKey} já usada com outro payload`,
        existing.id,
      );
    }
    this.registerInbox(context, command, payloadHash, now, inboxAlreadyRecorded);
    if (!inboxAlreadyRecorded) {
      this.metrics.duplicateDetected('idempotency_replay');
    }
    return toResult(existing, true);
  }

  /** Registra a mensagem SQS na inbox na mesma transação do efeito (PK barra redelivery concorrente). */
  private registerInbox(
    context: TransactionalContext,
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
    now: Date,
    inboxAlreadyRecorded: boolean,
  ): void {
    if (!command.inboxMessage || inboxAlreadyRecorded) return;
    const inboxMessage = InboxMessage.receive({
      consumerName: command.inboxMessage.consumerName,
      messageId: command.inboxMessage.messageId,
      payloadHash,
      receivedAt: now,
    });
    // Efeito e registro commitam juntos, então a mensagem já nasce processada.
    inboxMessage.markProcessed(now);
    context.inbox.add(inboxMessage);
  }

  private buildTransaction(
    command: SubmitWagerTransactionCommand,
    request: WagerRequest,
    money: Money,
    payloadHash: string,
    now: Date,
  ): WagerTransaction {
    try {
      return WagerTransaction.create({
        id: generateId(),
        providerId: request.providerId,
        externalTransactionId: request.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: request.walletId,
        playerId: request.playerId,
        roundId: request.roundId,
        gameId: request.gameId,
        kind: request.kind,
        money,
        referenceExternalTransactionId: request.referenceExternalTransactionId,
        createdAt: now,
      });
    } catch (error) {
      throw error instanceof DomainError ? new InvalidRequestError(error.message, { code: error.code }) : error;
    }
  }

  private parseRequest(command: SubmitWagerTransactionCommand): WagerRequest {
    if (!command.idempotencyKey || command.idempotencyKey.length > 512) {
      throw new InvalidRequestError('Idempotency-Key é obrigatória (até 512 caracteres)');
    }
    const parsed = wagerRequestSchema.safeParse(command.request);
    if (!parsed.success) {
      throw new InvalidRequestError('payload inválido', parsed.error.flatten());
    }
    return parsed.data;
  }

  private parseMoney(moneyProps: MoneyProps): Money {
    try {
      return Money.from(moneyProps);
    } catch (error) {
      throw error instanceof DomainError ? new InvalidRequestError(error.message, { code: error.code }) : error;
    }
  }

  private recordOutcome(
    command: SubmitWagerTransactionCommand,
    request: WagerRequest,
    result: WagerTransactionResult,
    startedAt: number,
  ): void {
    this.metrics.processingLatency(command.source, (performance.now() - startedAt) / 1000);
    if (!result.idempotentReplay) {
      this.metrics.transactionFinalized(request.kind, result.status);
    }
    this.logger.info(
      {
        correlationId: command.correlationId,
        messageId: command.inboxMessage?.messageId,
        transactionId: result.transactionId,
        walletId: request.walletId,
        providerId: request.providerId,
        kind: request.kind,
        status: result.status,
        failureCode: result.failureCode,
        idempotentReplay: result.idempotentReplay,
      },
      'transação de aposta processada',
    );
  }
}

export function toResult(transaction: WagerTransaction, idempotentReplay: boolean): WagerTransactionResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    ...(transaction.resultingBalance ? { balance: transaction.resultingBalance.toJSON() } : {}),
    ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
    idempotentReplay,
  };
}
