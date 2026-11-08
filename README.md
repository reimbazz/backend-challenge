# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas por HTTP e por SQS, correto sob mensagens duplicadas, fora de ordem e concorrentes, com múltiplas instâncias.

- Enunciado original: [docs/CHALLENGE.md](docs/CHALLENGE.md)
- Decisões, trade-offs e limitações: [ARCHITECTURE.md](ARCHITECTURE.md)

**Stack:** Bun 1.x · TypeScript strict · NestJS 11 · MikroORM 6 · PostgreSQL 16 · AWS SQS (LocalStack) · Docker Compose

---

## Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker + Docker Compose

> O Postgres do compose é exposto na porta **5433** do host para não colidir com um Postgres local na 5432.

## Setup rápido (desenvolvimento local)

```bash
bun install
bun run infra:up          # Postgres + LocalStack (filas criadas automaticamente)
bun run migration:up      # aplica o schema
bun run start             # API + workers em http://localhost:3000
```

## Três instâncias com Docker Compose

```bash
docker compose --profile app up --build
```

Sobe Postgres, LocalStack, um container `migrate` (one-shot) e **três instâncias** (`app-1..3`, portas 3001–3003) disputando o mesmo banco e a mesma fila, todas com consumer SQS, publisher da outbox e worker de referências pendentes.

## Comandos

| Comando | O que faz |
|---|---|
| `bun run start` / `start:dev` | sobe a aplicação (dev com watch) |
| `bun run typecheck` | `tsc --noEmit` em modo strict |
| `bun run test` | **suíte completa** (requer `infra:up`) |
| `bun run test:unit` | só testes de unidade (sem infraestrutura) |
| `bun run test:integration` | Postgres + LocalStack reais |
| `bun run test:concurrency` | paralelismo real, 3 processos, SIGKILL + reinício |
| `bun run migration:up` / `migration:down` / `migration:reset` | migrations (reversíveis) |
| `bun run infra:up` / `infra:down` | sobe/derruba Postgres + LocalStack |

Os testes usam o banco `wagering_test` (criado automaticamente) e filas SQS próprias criadas por arquivo de teste.

## Variáveis de ambiente

Defaults em [.env.example](.env.example) e [app-config.ts](src/infrastructure/config/app-config.ts).

| Variável | Default | Descrição |
|---|---|---|
| `HTTP_PORT` | `3000` | porta HTTP |
| `INSTANCE_NAME` | `local-1` | identifica a instância nos logs |
| `WORKERS_ENABLED` | `true` | liga consumer SQS, publisher da outbox e worker de referências |
| `DATABASE_HOST` / `PORT` / `NAME` / `USER` / `PASSWORD` | `localhost` / `5433` / `wagering` / `wagering` / `wagering` | PostgreSQL |
| `DATABASE_POOL_MAX` | `20` | conexões por instância |
| `SQS_ENDPOINT` | `http://localhost:4566` | LocalStack |
| `SQS_WAGER_QUEUE_NAME` / `SQS_WAGER_DLQ_NAME` | `wager-transactions.fifo` / `wager-transactions-dlq.fifo` | entrada e DLQ |
| `SQS_EVENTS_QUEUE_NAME` | `wagering-events.fifo` | destino dos eventos da outbox |
| `SQS_MAX_RECEIVE_COUNT` | `5` | tentativas antes da DLQ |
| `SQS_RETRY_BASE_DELAY_SECONDS` | `2` | base do backoff de visibilidade |
| `SQS_WAIT_TIME_SECONDS` | `5` | long polling |
| `LOG_LEVEL` | `info` | nível do pino |

## API

| Método | Rota | Auth |
|---|---|---|
| `POST` | `/wallets` | guard (no-op) |
| `GET` | `/wallets/:walletId` | guard |
| `GET` | `/wallets/:walletId/ledger?cursor=&limit=` | guard |
| `POST` | `/wallets/:walletId/reconciliation` | guard |
| `POST` | `/wagering/transactions` (header `Idempotency-Key` obrigatório) | guard |
| `GET` | `/wagering/transactions/:transactionId` | guard |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | guard |
| `GET` | `/health/live` · `/health/ready` · `/metrics` | aberto |

Status HTTP de `POST /wagering/transactions`:

| Status | Significado | Provedor deve |
|---|---|---|
| `200` | `PROCESSED` (também no replay — ver `idempotentReplay`) | nada |
| `202` | `PENDING_REFERENCE` — referência ainda não chegou | consultar depois |
| `422` | `REJECTED` por regra de negócio (`failureCode` no corpo) | não reenviar |
| `400` | payload inválido / `Idempotency-Key` ausente | corrigir |
| `409` | mesma key (ou mesmo `externalTransactionId`) com payload diferente | não reenviar |
| `503` | falha transitória (`Retry-After`) | reenviar igual |

### Exemplo

```bash
# criar wallet
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# aposta
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:transaction-123' \
  -d '{"providerId":"provider-a","externalTransactionId":"transaction-123",
       "playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"<id da wallet>",
       "roundId":"round-987","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
```

### Enviando pela fila

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id <walletId> --message-deduplication-id msg-123 \
  --message-body '{"messageId":"msg-123","type":"WagerTransactionRequested","occurredAt":"2026-07-29T15:00:00.000Z",
    "data":{"providerId":"provider-a","externalTransactionId":"transaction-124","idempotencyKey":"provider-a:transaction-124",
    "playerId":"<playerId>","walletId":"<walletId>","roundId":"round-987","gameId":"fortune-chimp",
    "kind":"BET","money":{"amount":"10.00","currency":"BRL"}}}'
```

## Estrutura

```
src/
  domain/          Money, Wallet, WagerTransaction, ledger, inbox/outbox, eventos — TS puro
  application/     use cases, portas (repositórios, UnitOfWork, publisher, métricas), erros
  infrastructure/  MikroORM (records, mappers, repositórios, migrations), SQS, pino, prom-client
  interfaces/      controllers HTTP, consumer SQS, workers
test/
  unit/            domínio
  integration/     schema/constraints, use cases, mensageria (Postgres + LocalStack reais)
  concurrency/     paralelismo in-process, 3 processos via HTTP, SIGKILL + reinício
```
