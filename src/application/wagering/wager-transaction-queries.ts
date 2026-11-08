import { MoneyProps } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { NotFoundError } from '../errors';
import { UnitOfWork } from '../ports/repositories';
import { assertUuid } from '../wallets/wallet-use-cases';

export interface WagerTransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  status: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: string;
  balance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

export class WagerTransactionQueries {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  /** @throws NotFoundError */
  async getById(transactionId: string): Promise<WagerTransactionView> {
    assertUuid(transactionId);
    const transaction = await this.unitOfWork.run((context) => context.transactions.findById(transactionId));
    if (!transaction) throw new NotFoundError('transação', transactionId);
    return toTransactionView(transaction);
  }

  /** @throws NotFoundError */
  async getByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionView> {
    const transaction = await this.unitOfWork.run((context) =>
      context.transactions.findByExternalId(providerId, externalTransactionId),
    );
    if (!transaction) throw new NotFoundError('transação', `${providerId}/${externalTransactionId}`);
    return toTransactionView(transaction);
  }
}

function toTransactionView(transaction: WagerTransaction): WagerTransactionView {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    status: transaction.status,
    money: transaction.money.toJSON(),
    ...(transaction.referenceExternalTransactionId
      ? { referenceExternalTransactionId: transaction.referenceExternalTransactionId }
      : {}),
    ...(transaction.referenceTransactionId ? { referenceTransactionId: transaction.referenceTransactionId } : {}),
    ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
    ...(transaction.resultingBalance ? { balance: transaction.resultingBalance.toJSON() } : {}),
    createdAt: transaction.createdAt.toISOString(),
    ...(transaction.processedAt ? { processedAt: transaction.processedAt.toISOString() } : {}),
  };
}
