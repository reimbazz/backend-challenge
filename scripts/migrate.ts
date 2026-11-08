import { MikroORM } from '@mikro-orm/postgresql';
import { buildMikroOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config';

/**
 * Uso: bun run scripts/migrate.ts [up|down|reset]
 *   up    aplica migrations pendentes (cria o banco se não existir)
 *   down  reverte a última migration
 *   reset reverte todas e aplica de novo
 */
async function runMigrations(command: string): Promise<void> {
  const orm = await MikroORM.init(buildMikroOrmConfig());
  try {
    await orm.schema.ensureDatabase();
    const migrator = orm.getMigrator();

    if (command === 'down') {
      await migrator.down();
    } else if (command === 'reset') {
      await migrator.down({ to: 0 });
      await migrator.up();
    } else {
      await migrator.up();
    }

    const executedMigrations = await migrator.getExecutedMigrations();
    console.log(`migrations aplicadas: ${executedMigrations.map((migration) => migration.name).join(', ') || '(nenhuma)'}`);
  } finally {
    await orm.close(true);
  }
}

await runMigrations(process.argv[2] ?? 'up');
