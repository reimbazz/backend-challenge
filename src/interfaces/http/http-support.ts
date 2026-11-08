import {
  ArgumentsHost,
  CanActivate,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { Logger } from 'pino';
import {
  ApplicationError,
  IdempotencyConflictError,
  InvalidRequestError,
  InvariantViolationError,
  NotFoundError,
  TransientInfrastructureError,
  WalletAlreadyExistsError,
} from '../../application/errors';
import { generateId } from '../../domain/shared/identifiers';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

export type RequestWithCorrelation = Request & { correlationId: string };

export function correlationIdOf(request: Request): string {
  return (request as RequestWithCorrelation).correlationId;
}

/**
 * Propaga/gera o correlationId e registra uma linha de access log por requisição
 * (método, rota, status, duração — nunca o corpo).
 */
export function correlationAndAccessLogMiddleware(logger: Logger) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const incomingCorrelationId = request.header(CORRELATION_ID_HEADER);
    const correlationId =
      incomingCorrelationId && incomingCorrelationId.length <= 128 ? incomingCorrelationId : generateId();
    (request as RequestWithCorrelation).correlationId = correlationId;
    response.setHeader(CORRELATION_ID_HEADER, correlationId);

    const startedAt = performance.now();
    response.on('finish', () => {
      logger.info(
        {
          correlationId,
          method: request.method,
          path: request.path,
          statusCode: response.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        },
        'http request',
      );
    });
    next();
  };
}

/**
 * Ponto de extensão de autenticação (seção 2 do desafio, não implementada).
 * Desenho previsto: provedores autenticam via OIDC client-credentials no Keycloak; este guard
 * valida o JWT (assinatura via JWKS, issuer, audience) e confere que o claim do provider
 * corresponde ao `providerId` do payload. Health e /metrics ficam fora do guard.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
  correlationId: string;
}

/**
 * Mapeamento único de erros → HTTP, consistente em todos os endpoints:
 *   400 payload inválido · 404 inexistente · 409 conflito (idempotência/duplicidade)
 *   503 falha transitória (Retry-After) · 500 violação de invariante/erro inesperado
 * Rejeições de negócio não passam por aqui: são resultado (422) do use case.
 */
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const httpContext = host.switchToHttp();
    const request = httpContext.getRequest<Request>();
    const response = httpContext.getResponse<Response>();
    const correlationId = correlationIdOf(request) ?? 'unknown';

    const { status, code, message, details } = this.classify(exception);
    if (status >= 500) {
      this.logger.error(
        { correlationId, path: request.path, code, err: exception instanceof Error ? { name: exception.name, message: exception.message } : String(exception) },
        'erro ao processar requisição',
      );
    }
    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      response.setHeader('Retry-After', '1');
    }

    const body: ErrorBody = { error: { code, message, ...(details !== undefined ? { details } : {}) }, correlationId };
    response.status(status).json(body);
  }

  private classify(exception: unknown): { status: number; code: string; message: string; details?: unknown } {
    if (exception instanceof InvalidRequestError) {
      return { status: HttpStatus.BAD_REQUEST, code: exception.code, message: exception.message, details: exception.details };
    }
    if (exception instanceof NotFoundError) {
      return { status: HttpStatus.NOT_FOUND, code: exception.code, message: exception.message };
    }
    if (exception instanceof IdempotencyConflictError) {
      return {
        status: HttpStatus.CONFLICT,
        code: exception.code,
        message: exception.message,
        details: { existingTransactionId: exception.existingTransactionId },
      };
    }
    if (exception instanceof WalletAlreadyExistsError) {
      return { status: HttpStatus.CONFLICT, code: exception.code, message: exception.message };
    }
    if (exception instanceof TransientInfrastructureError) {
      return { status: HttpStatus.SERVICE_UNAVAILABLE, code: exception.code, message: 'falha transitória; tente novamente' };
    }
    if (exception instanceof InvariantViolationError) {
      return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: exception.code, message: 'erro interno' };
    }
    if (exception instanceof ApplicationError) {
      return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: exception.code, message: 'erro interno' };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        code: status === HttpStatus.BAD_REQUEST ? 'INVALID_REQUEST' : status === HttpStatus.NOT_FOUND ? 'NOT_FOUND' : 'HTTP_ERROR',
        message: exception.message,
      };
    }
    return { status: HttpStatus.INTERNAL_SERVER_ERROR, code: 'INTERNAL_ERROR', message: 'erro interno' };
  }
}
