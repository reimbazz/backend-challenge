import { Migrator } from '@mikro-orm/migrations';
import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { AppConfig, loadAppConfig } from '../config/app-config';
import { Migration20261107000000InitialSchema } from './migrations/Migration20261107000000InitialSchema';
import { ALL_RECORD_SCHEMAS } from './records';

/**
 * Migrations registradas explicitamente (sem descoberta por glob) para funcionar igual
 * em Bun, em container e nos testes.
 */
export const MIGRATIONS_LIST = [
  { name: 'Migration20261107000000InitialSchema', class: Migration20261107000000InitialSchema },
];

export function buildMikroOrmConfig(databaseConfig: AppConfig['database'] = loadAppConfig().database) {
  return defineConfig({
    driver: PostgreSqlDriver,
    host: databaseConfig.host,
    port: databaseConfig.port,
    dbName: databaseConfig.name,
    user: databaseConfig.user,
    password: databaseConfig.password,
    entities: ALL_RECORD_SCHEMAS,
    extensions: [Migrator],
    migrations: {
      migrationsList: MIGRATIONS_LIST,
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    pool: { min: 0, max: databaseConfig.poolMax },
    // Força o uso de um EntityManager por requisição/transação (sem estado global compartilhado).
    allowGlobalContext: false,
    debug: false,
  });
}

export default buildMikroOrmConfig();
