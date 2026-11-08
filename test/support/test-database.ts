import { MikroORM } from '@mikro-orm/postgresql';
import { loadAppConfig } from '../../src/infrastructure/config/app-config';
import { buildMikroOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

/** Banco dedicado aos testes, separado do banco de desenvolvimento. */
export const TEST_DATABASE_NAME = process.env.TEST_DATABASE_NAME ?? 'wagering_test';

export function testDatabaseConfig() {
  return { ...loadAppConfig().database, name: TEST_DATABASE_NAME };
}

/**
 * Sobe um MikroORM contra o Postgres real (container), criando o banco e aplicando migrations.
 * Os testes usam ids aleatórios, então não precisam limpar tabelas (o ledger nem permite).
 */
export async function createTestOrm(): Promise<MikroORM> {
  const orm = await MikroORM.init(buildMikroOrmConfig(testDatabaseConfig()));
  await orm.schema.ensureDatabase();
  await orm.getMigrator().up();
  return orm;
}
