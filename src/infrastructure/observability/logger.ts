import { LoggerService } from '@nestjs/common';
import pino, { Logger } from 'pino';
import { StructuredLogger } from '../../application/ports/observability';

/**
 * Logger JSON (pino). Campos sensíveis são removidos por redact como defesa adicional —
 * por convenção, payloads e valores financeiros completos nunca são logados.
 */
export function createRootLogger(instanceName: string, level = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({
    level,
    base: { instance: instanceName },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['authorization', 'headers.authorization', 'payload', 'body', 'request.body', '*.password'],
      remove: true,
    },
  });
}

export function asStructuredLogger(logger: Logger): StructuredLogger {
  return {
    info: (context, message) => logger.info(context, message),
    warn: (context, message) => logger.warn(context, message),
    error: (context, message) => logger.error(context, message),
  };
}

/** Encaminha os logs internos do NestJS para o mesmo logger JSON. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
}
