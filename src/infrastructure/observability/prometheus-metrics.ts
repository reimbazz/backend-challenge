import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { DuplicateSource, WageringMetrics } from '../../application/ports/observability';

/** Métricas da seção 12, expostas em GET /metrics no formato Prometheus. */
export class PrometheusWageringMetrics implements WageringMetrics {
  readonly registry = new Registry();

  private readonly transactionsByStatus = new Counter({
    name: 'wagering_transactions_total',
    help: 'Transações finalizadas por kind e status',
    labelNames: ['kind', 'status'] as const,
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_detected_total',
    help: 'Duplicatas detectadas (replay por idempotency key ou redelivery via inbox)',
    labelNames: ['source'] as const,
    registers: [this.registry],
  });

  private readonly lockConflicts = new Counter({
    name: 'wagering_lock_conflicts_total',
    help: 'Lock timeouts, deadlocks e conflitos de versão',
    registers: [this.registry],
  });

  private readonly retries = new Counter({
    name: 'wagering_retries_total',
    help: 'Novas tentativas por operação',
    labelNames: ['operation'] as const,
    registers: [this.registry],
  });

  private readonly deadLetters = new Counter({
    name: 'wagering_dlq_messages_total',
    help: 'Mensagens encaminhadas para a DLQ',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  private readonly latency = new Histogram({
    name: 'wagering_processing_latency_seconds',
    help: 'Latência de processamento de transações',
    labelNames: ['source'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  private readonly outboxLagSeconds = new Gauge({
    name: 'wagering_outbox_lag_seconds',
    help: 'Idade do evento pendente mais antigo na outbox',
    registers: [this.registry],
  });

  private readonly reconciliationMismatches = new Counter({
    name: 'wagering_reconciliation_mismatches_total',
    help: 'Divergências entre saldo materializado e ledger',
    registers: [this.registry],
  });

  constructor(options: { collectDefaults?: boolean } = {}) {
    if (options.collectDefaults) {
      collectDefaultMetrics({ register: this.registry });
    }
  }

  transactionFinalized(kind: string, status: string): void {
    this.transactionsByStatus.inc({ kind, status });
  }
  duplicateDetected(source: DuplicateSource): void {
    this.duplicates.inc({ source });
  }
  lockConflict(): void {
    this.lockConflicts.inc();
  }
  retry(operation: string): void {
    this.retries.inc({ operation });
  }
  messageSentToDlq(reason: string): void {
    this.deadLetters.inc({ reason });
  }
  processingLatency(source: 'http' | 'sqs' | 'worker', seconds: number): void {
    this.latency.observe({ source }, seconds);
  }
  outboxLag(seconds: number): void {
    this.outboxLagSeconds.set(seconds);
  }
  reconciliationMismatch(): void {
    this.reconciliationMismatches.inc();
  }
}
