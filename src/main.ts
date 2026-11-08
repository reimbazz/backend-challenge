import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Logger } from 'pino';
import { AppModule } from './app.module';
import { loadAppConfig } from './infrastructure/config/app-config';
import type { AppConfig } from './infrastructure/config/app-config';
import { createRootLogger, PinoNestLogger } from './infrastructure/observability/logger';
import { correlationAndAccessLogMiddleware, HttpErrorFilter } from './interfaces/http/http-support';

export async function createApp(config: AppConfig, rootLogger: Logger): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(config, rootLogger), {
    logger: new PinoNestLogger(rootLogger),
  });
  app.use(correlationAndAccessLogMiddleware(rootLogger));
  app.useGlobalFilters(new HttpErrorFilter(rootLogger));
  app.enableShutdownHooks();
  return app;
}

async function bootstrap(): Promise<void> {
  const config = loadAppConfig();
  const rootLogger = createRootLogger(config.instanceName);
  const app = await createApp(config, rootLogger);
  await app.listen(config.httpPort, '0.0.0.0');
  rootLogger.info({ port: config.httpPort }, 'serviço iniciado');
}

if (import.meta.main) {
  await bootstrap();
}
