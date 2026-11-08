import { EventPublisher } from '../ports/event-publisher';
import { Clock, StructuredLogger, WageringMetrics } from '../ports/observability';
import { UnitOfWork } from '../ports/repositories';

/**
 * Publisher da Transactional Outbox.
 *
 * - Concorrência: `claimDue` usa FOR UPDATE SKIP LOCKED — publishers em várias instâncias
 *   pegam lotes disjuntos, sem lock global.
 * - Crash: se o processo morrer depois de publicar e antes do commit que grava `published_at`,
 *   os locks caem e outra instância publica de novo. Duplicata é segura: o eventId é o mesmo
 *   (consumidores deduplicam por ele) e vai como MessageDeduplicationId na fila FIFO.
 * - Falha de publicação: a mensagem recebe backoff (scheduleRetry) e volta depois — nunca é perdida.
 */
export class PublishOutboxUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: WageringMetrics,
    private readonly logger: StructuredLogger,
  ) {}

  /** @returns quantos eventos foram publicados nesta rodada */
  async runOnce(batchSize = 10): Promise<number> {
    const publishedCount = await this.unitOfWork.run(async (context) => {
      const now = this.clock.now();
      const claimedMessages = await context.outbox.claimDue(now, batchSize);
      if (claimedMessages.length === 0) return 0;

      const outcomes = await this.publisher.publish(claimedMessages);
      const outcomeById = new Map(outcomes.map((outcome) => [outcome.outboxMessageId, outcome]));

      let publishedInBatch = 0;
      for (const message of claimedMessages) {
        const outcome = outcomeById.get(message.id);
        if (outcome?.published) {
          message.markPublished(now);
          publishedInBatch++;
        } else {
          message.scheduleRetry(now, outcome?.errorMessage ?? 'sem confirmação do broker');
          this.metrics.retry('outbox_publish');
          this.logger.warn(
            { eventId: message.id, walletId: message.aggregateId, eventType: message.eventType, attempts: message.attempts },
            'falha ao publicar evento; nova tentativa agendada',
          );
        }
        context.outbox.save(message);
      }
      return publishedInBatch;
    });

    await this.refreshLagMetric();
    return publishedCount;
  }

  private async refreshLagMetric(): Promise<void> {
    const oldestPendingAt = await this.unitOfWork.run((context) => context.outbox.oldestPendingOccurredAt());
    const lagSeconds = oldestPendingAt ? Math.max(0, (this.clock.now().getTime() - oldestPendingAt.getTime()) / 1000) : 0;
    this.metrics.outboxLag(lagSeconds);
  }
}
