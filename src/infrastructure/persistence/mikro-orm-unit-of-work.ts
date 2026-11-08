import {
  CheckConstraintViolationException,
  ConnectionException,
  ConstraintViolationException,
  DeadlockException,
  LockWaitTimeoutException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import {
  ApplicationError,
  InvariantViolationError,
  TransientInfrastructureError,
  UniqueConstraintConflictError,
} from '../../application/errors';
import { WageringMetrics } from '../../application/ports/observability';
import { TransactionalContext, UnitOfWork } from '../../application/ports/repositories';
import {
  MikroOrmInboxRepository,
  MikroOrmLedgerRepository,
  MikroOrmOutboxRepository,
  MikroOrmWagerTransactionRepository,
  MikroOrmWalletRepository,
} from './mikro-orm-repositories';

/** Espera máxima por um lock de linha antes de desistir (vira erro transitório). */
const LOCK_TIMEOUT = '5s';
const STATEMENT_TIMEOUT = '15s';

/**
 * UnitOfWork sobre `em.transactional()`: cada chamada usa um EntityManager novo (fork),
 * isolamento READ COMMITTED + locks explícitos de linha. Flush e commit acontecem ao
 * final; os constraint triggers deferred do schema validam a consistência no commit.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly metrics?: WageringMetrics,
  ) {}

  async run<T>(work: (context: TransactionalContext) => Promise<T>): Promise<T> {
    const entityManager = this.orm.em.fork();
    try {
      return await entityManager.transactional(async (transactionalEntityManager) => {
        await transactionalEntityManager.execute(
          `SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'; SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`,
        );
        return work(createContext(transactionalEntityManager));
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  /** Converte exceções do driver em erros de aplicação com semântica de retry clara. */
  private translate(error: unknown): unknown {
    if (error instanceof ApplicationError) return error;

    if (error instanceof UniqueConstraintViolationException) {
      return new UniqueConstraintConflictError(extractConstraintName(error), error);
    }
    if (error instanceof LockWaitTimeoutException || error instanceof DeadlockException) {
      this.metrics?.lockConflict();
      return new TransientInfrastructureError('conflito de lock no banco', error);
    }
    if (error instanceof CheckConstraintViolationException || error instanceof ConstraintViolationException) {
      return new InvariantViolationError(`banco recusou estado inconsistente: ${(error as Error).message}`, error);
    }
    if (error instanceof ConnectionException || isConnectionFailure(error)) {
      return new TransientInfrastructureError('banco de dados indisponível', error);
    }
    return error;
  }
}

function createContext(entityManager: EntityManager): TransactionalContext {
  return {
    wallets: new MikroOrmWalletRepository(entityManager),
    transactions: new MikroOrmWagerTransactionRepository(entityManager),
    ledger: new MikroOrmLedgerRepository(entityManager),
    inbox: new MikroOrmInboxRepository(entityManager),
    outbox: new MikroOrmOutboxRepository(entityManager),
  };
}

function extractConstraintName(error: Error): string | undefined {
  const driverError = error as Error & { constraint?: string };
  return driverError.constraint ?? /constraint "([^"]+)"/.exec(error.message)?.[1];
}

const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE', '57P01', '57P03', '08006', '08001']);

function isConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const errorCode = (error as Error & { code?: string }).code;
  return (
    (errorCode !== undefined && CONNECTION_ERROR_CODES.has(errorCode)) ||
    /Timeout acquiring a connection|Connection terminated|connect ECONNREFUSED/i.test(error.message)
  );
}
