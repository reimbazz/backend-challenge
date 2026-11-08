import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction';
import { Clock, StructuredLogger, WageringMetrics } from '../ports/observability';
import { UnitOfWork } from '../ports/repositories';
import { WagerTransactionProcessor } from './wager-transaction-processor';

/**
 * Worker de PENDING_REFERENCE (seção 7.1). Cada transação é reprocessada na sua própria
 * transação SQL, travando a wallet antes de reler o status — duas instâncias executando
 * o worker ao mesmo tempo serializam na wallet e a segunda encontra a transação já resolvida.
 */
export class ResolvePendingReferencesUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly processor: WagerTransactionProcessor,
    private readonly clock: Clock,
    private readonly metrics: WageringMetrics,
    private readonly logger: StructuredLogger,
  ) {}

  /** @returns quantas transações saíram de PENDING_REFERENCE nesta rodada */
  async runOnce(batchSize = 50): Promise<number> {
    const now = this.clock.now();
    const dueTransactions = await this.unitOfWork.run((context) =>
      context.transactions.findDuePendingReferences(now, batchSize),
    );

    let resolvedCount = 0;
    for (const { transactionId, walletId } of dueTransactions) {
      try {
        const finalStatus = await this.resolveOne(transactionId, walletId);
        if (finalStatus && finalStatus !== WagerTransactionStatus.PendingReference) {
          resolvedCount++;
        }
      } catch (error) {
        this.metrics.retry('resolve_pending_reference');
        this.logger.warn(
          { transactionId, walletId, reason: (error as Error).message },
          'falha ao resolver referência pendente; será tentado de novo',
        );
      }
    }
    return resolvedCount;
  }

  private async resolveOne(transactionId: string, walletId: string): Promise<WagerTransactionStatus | undefined> {
    const startedAt = performance.now();

    const finalTransaction = await this.unitOfWork.run(async (context) => {
      const now = this.clock.now();
      const wallet = await context.wallets.findByIdForUpdate(walletId);
      const transaction = await context.transactions.findById(transactionId);

      const stillDue =
        transaction?.status === WagerTransactionStatus.PendingReference &&
        transaction.nextReferenceResolutionAt !== undefined &&
        transaction.nextReferenceResolutionAt <= now;
      if (!transaction || !stillDue) {
        return undefined;
      }

      return this.processor.apply(context, transaction, wallet, now, {
        correlationId: context.transactions.correlationIdOf(transaction.id) ?? transaction.id,
        causationId: transaction.id,
        occurredAt: now,
      });
    });

    if (!finalTransaction) return undefined;

    this.metrics.processingLatency('worker', (performance.now() - startedAt) / 1000);
    if (finalTransaction.status !== WagerTransactionStatus.PendingReference) {
      this.metrics.transactionFinalized(finalTransaction.kind, finalTransaction.status);
      this.logger.info(
        {
          correlationId: transactionId,
          transactionId,
          walletId,
          providerId: finalTransaction.providerId,
          status: finalTransaction.status,
          failureCode: finalTransaction.failureCode,
          attempts: finalTransaction.referenceResolutionAttempts,
        },
        'referência pendente resolvida',
      );
    }
    return finalTransaction.status;
  }
}
