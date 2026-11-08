# Arquitetura

Este documento registra as decisões técnicas, o porquê de cada uma, os trade-offs e as limitações conhecidas. A premissa central: **o banco é o árbitro final das invariantes**. Código de aplicação, locks e recursos do broker reduzem conflitos; constraints e triggers garantem que um estado inválido nunca seja commitado.

---

## 1. Camadas

```
interfaces/      HTTP (NestJS controllers) · consumer SQS · workers
     │                     │
     ▼                     ▼
application/     SubmitWagerTransaction  ←── mesmo use case para HTTP e SQS
                 WagerTransactionProcessor (regras de aplicação de BET/WIN/LOSS/REFUND/ROLLBACK)
                 ResolvePendingReferences · PublishOutbox · CreateWallet · consultas
                 portas: UnitOfWork, repositórios, EventPublisher, métricas, logger, clock
     │
     ▼
domain/          Money, Wallet, WagerTransaction, WalletLedgerEntry, Inbox/OutboxMessage,
                 IntegrationEvent — TypeScript puro, sem NestJS nem ORM
     ▲
infrastructure/  MikroORM (EntitySchema, mappers, repositórios, UnitOfWork, migration),
                 SQS (publisher, resolver), pino, prom-client
```

- O domínio não importa nada de framework. Toda entidade tem construtor privado e factories `create`/`open`/`enqueue` (validam) e `rehydrate` (reconstrói sem revalidar transições).
- Os use cases são classes simples montadas por factory no composition root ([app.module.ts](src/app.module.ts)); não dependem do NestJS e são testados diretamente contra Postgres real.
- Persistência usa **modelos separados do domínio** ([records.ts](src/infrastructure/persistence/records.ts)) mapeados por `EntitySchema` (sem decorators) e convertidos por [mappers.ts](src/infrastructure/persistence/mappers.ts).

## 2. ORM, Money e estratégia transacional

**MikroORM** (preferencial do desafio): `em.transactional()` dá uma transação por unidade de trabalho com fork do EntityManager (sem estado global — `allowGlobalContext: false`), e `LockMode` expõe `FOR UPDATE`, `FOR SHARE` e `FOR UPDATE SKIP LOCKED` sem SQL manual.

**Money**
- Domínio: `decimal.js` em instância isolada com 40 dígitos de precisão; escala fixa de 2 casas; imutável.
- Entrada: regex `^\d+(\.\d{1,2})?$` — rejeita `NaN`, `Infinity`, notação científica, vazio, sinal, mais de 2 casas e negativos. Valor `number` no JSON é rejeitado (400).
- **Nunca há arredondamento implícito**: entradas com mais de 2 casas são recusadas em vez de arredondadas.
- Persistência: `numeric(19,2)` + `char(3)` em colunas separadas. O MikroORM hidrata `numeric` como **string**, que vira `Money.rehydrate` — o valor nunca passa por `number`. Somas da reconciliação são feitas em `numeric` no SQL e voltam como texto.
- Modelo multi-moeda; operações entre moedas lançam `CurrencyMismatchError`; transação em moeda diferente da wallet é `REJECTED` com `CURRENCY_MISMATCH` (testado).

**Transação**: isolamento `READ COMMITTED` + locks explícitos de linha. Cada unidade de trabalho define `SET LOCAL lock_timeout = '5s'` e `statement_timeout = '15s'`. Inserts são acumulados no Unit of Work do MikroORM e enviados no flush do commit; FKs e triggers de consistência são `DEFERRABLE INITIALLY DEFERRED`, então a ordem dos INSERTs é irrelevante e a validação ocorre no `COMMIT`.

## 3. Garantias no schema

Migration: [Migration20261107000000InitialSchema.ts](src/infrastructure/persistence/migrations/Migration20261107000000InitialSchema.ts) (reversível; `up`/`down` testados).

| Invariante | Mecanismo no banco |
|---|---|
| Uma wallet por `playerId + currency` | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` |
| Ledger imutável | triggers bloqueiam `UPDATE`, `DELETE` e `TRUNCATE` |
| Aritmética do lançamento | `CHECK (balance_after = balance_before ± amount)`, `amount > 0` |
| Ledger encadeado | trigger: `wallet_version` sequencial e `balance_before` = `balance_after` anterior (primeira entrada parte de 0) |
| No máximo um lançamento por transação e wallet | `UNIQUE (transaction_id, wallet_id)` |
| Uma entrada por versão da wallet | `UNIQUE (wallet_id, wallet_version)` |
| Saldo materializado == ledger | constraint trigger deferred em `wallets`: saldo e versão = última entrada (ou 0 sem entradas) |
| Transação tem lançamento ⇔ `PROCESSED` e não `LOSS` | constraint triggers deferred em `wager_transactions` e no ledger |
| Moeda do lançamento = moeda da wallet | FK composta `(wallet_id, currency) → wallets(id, currency)` |
| Idempotência persistente | `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Referência revertida no máximo uma vez | índice único parcial em `reference_transaction_id WHERE kind IN (REFUND, ROLLBACK) AND status = PROCESSED` |
| Uma `OPENING` por wallet | índice único parcial |
| Status terminal imutável e campos do pedido imutáveis | trigger `BEFORE UPDATE` |
| Coerência de estado | `CHECK`s: `failure_code` ⇔ `REJECTED/FAILED`; `processed_at` ⇔ terminal; agendamento ⇔ `PENDING_REFERENCE`; `REFUND/ROLLBACK` exigem referência |
| Inbox sem duplicata | `PRIMARY KEY (consumer_name, message_id)` |

`wallet_version` no ledger é o número da versão da wallet produzida pelo lançamento. Isso amarra saldo e ledger 1:1 e serve de **cursor estável** da paginação (`base64url({"v": versão})`).

## 4. Concorrência

**Unidade de concorrência: a linha da wallet.**

1. `SELECT ... FOR UPDATE` na wallet antes de qualquer decisão financeira. Operações da mesma wallet serializam entre todas as instâncias; wallets diferentes seguem em paralelo. Não há lock global.
2. Depois do lock, a idempotency key é **verificada de novo**: outra instância pode ter commitado enquanto esta esperava (em `READ COMMITTED` cada statement vê o último commit).
3. O `UPDATE` do saldo é condicionado à versão lida (`WHERE id = ? AND version = ?`); 0 linhas afetadas → `ConcurrencyConflictError` (transitório). É defesa em profundidade: com o lock, não deveria acontecer.
4. `lock_timeout` de 5s transforma espera excessiva em erro transitório (503 / retry na fila), contabilizado em `wagering_lock_conflicts_total`.
5. Deadlock: cada transação de aposta trava **uma** wallet; o worker de referências trava wallet → transação, mesma ordem. O `wakeDependents` só toca transações da mesma wallet já travada.

**Por que pessimista e não otimista?** Em hot wallets (muitas apostas na mesma carteira) o otimista degrada em tempestade de retries e precisa de limite + backoff + tratamento de esgotamento. O lock de linha é curto (uma transação com poucos statements), previsível e fácil de provar correto. O custo é throughput serializado por wallet, aceitável porque a ordem por wallet já é exigida pelo domínio.

**Cenário obrigatório** (100.00, duas apostas de 80.00 simultâneas): a segunda transação espera o lock, relê saldo 20.00 e é `REJECTED` com `INSUFFICIENT_FUNDS`. Testado in-process, entre 3 processos via HTTP, e com retries das duas apostas.

## 5. Idempotência

- `Idempotency-Key` (header no HTTP, `data.idempotencyKey` na fila) é a fonte da verdade; escopo `(providerId, idempotencyKey)`.
- **payloadHash** = `SHA-256` (hex) do **JSON canônico** (chaves ordenadas recursivamente, sem espaços, campos `undefined` omitidos) de: `providerId, externalTransactionId, playerId, walletId, roundId, gameId, kind, money{amount,currency}, referenceExternalTransactionId`. `money` é normalizado por `Money.toJSON()` antes do hash (`"25"` ≡ `"25.00"`). Header, `messageId`, `occurredAt` e demais metadados de transporte ficam de fora — HTTP e SQS geram o mesmo hash. Implementação: [payload-hash.ts](src/application/wagering/payload-hash.ts).
- Mesma key + mesmo hash → **replay**: devolve o resultado gravado, inclusive o saldo observado na época (`resulting_balance`), com `idempotentReplay: true`.
- Mesma key + hash diferente → `409 IDEMPOTENCY_CONFLICT`. Mesmo `externalTransactionId` com outra key → também `409` (a referência é resolvida por `externalTransactionId`, então ele precisa ser único por provider).
- Corrida: se duas requisições passam pelas verificações ao mesmo tempo (ex.: wallet inexistente, sem lock), o `UNIQUE` barra uma delas no commit; o use case repete (até 3 vezes) e a repetição encontra o registro → replay.
- **Nenhuma idempotência em memória.** Rejeições também são persistidas e replicadas igual.

## 6. Regras de negócio e interpretações adotadas

| Operação | Saldo | Ledger |
|---|---|---|
| `BET` | débito | `DEBIT` — `INSUFFICIENT_FUNDS` se faltar saldo |
| `WIN` | crédito | `CREDIT` — referência opcional; se informada, deve ser `BET` `PROCESSED` do mesmo contexto |
| `LOSS` | — | nenhum; versão da wallet não muda |
| `REFUND` | crédito | `CREDIT` — referencia só `BET` |
| `ROLLBACK` | inverso da referência | invertido — referencia `BET`, `WIN` ou `REFUND` |

Interpretações (documentadas porque o enunciado deixa margem):

1. **Uma referência é revertida no máximo uma vez, somando REFUND e ROLLBACK.** O enunciado fala em "pelo mesmo tipo de operação"; permitir REFUND e depois ROLLBACK da mesma BET creditaria o jogador duas vezes. Optou-se pela regra mais restritiva. `ROLLBACK` de um `REFUND` continua permitido (a referência é outra).
2. Referência deve coincidir em provider, player, wallet, moeda e rodada (`REFERENCE_MISMATCH`), estar `PROCESSED` (`REFERENCE_NOT_PROCESSED`) e, em reversões, ter o mesmo valor (`REVERSAL_AMOUNT_MISMATCH`).
3. Referência existente mas ainda não terminal (ex.: `ROLLBACK` de um `REFUND` em `PENDING_REFERENCE`) é tratada como ausente: aguarda.
4. Valor zero é aceito apenas em `LOSS`; nas demais operações é payload inválido (400).
5. Wallet inexistente ou de outro player → transação persistida como `REJECTED` (`WALLET_NOT_FOUND` / `WALLET_PLAYER_MISMATCH`), para que o replay seja estável. Por isso `wager_transactions.wallet_id` não tem FK.
6. `OPENING` é criada só quando o saldo inicial > 0, na mesma transação SQL da wallet, já `PROCESSED`, e emite `WalletBalanceChanged`. Não pode ser submetida pela API nem pela fila.
7. `PENDING` existe apenas em memória durante o processamento: a transação é sempre commitada já em estado final ou em `PENDING_REFERENCE`.

### Máquina de estados

```
PENDING ──────────────┬─► PROCESSED
                      ├─► REJECTED
                      ├─► FAILED
                      └─► PENDING_REFERENCE ──┬─► PENDING_REFERENCE (nova tentativa)
                                              ├─► PROCESSED
                                              ├─► REJECTED (inclui REFERENCE_NOT_FOUND)
                                              └─► FAILED
```

`PROCESSED`, `REJECTED` e `FAILED` são terminais: transicioná-los lança `InvalidTransactionStateError` no domínio e é barrado por trigger no banco.

### Referências fora de ordem (7.1)

- Referência ausente → `PENDING_REFERENCE` (HTTP 202) + evento `WagerTransactionPendingReference` (só na primeira vez).
- Worker agendado com **backoff exponencial 2s, 4s, 8s … teto de 5 min**, **8 tentativas** (≈ 8,5 min no total). Escolha: cobre atrasos normais de entrega entre filas/provedores sem deixar saldo "em suspenso" por muito tempo.
- Quando a referência chega e é processada, as dependentes da mesma wallet têm a próxima tentativa antecipada para "agora" (`wakeDependents`), então a resolução não espera o backoff.
- Esgotado o limite: `REJECTED` com `REFERENCE_NOT_FOUND` + `WagerTransactionRejected`.
- Concorrência entre workers de várias instâncias: cada item é processado travando a wallet e relendo o status; a segunda instância encontra a transação já resolvida e pula.

### Taxonomia de `failureCode`

| Código | Status | Ação do provedor |
|---|---|---|
| `INSUFFICIENT_FUNDS` | REJECTED | desistir |
| `REVERSAL_INSUFFICIENT_FUNDS` | REJECTED | escalar — reversão deixaria saldo negativo (distinto de aposta sem saldo, regra 9) |
| `CURRENCY_MISMATCH` | REJECTED | corrigir payload |
| `WALLET_NOT_FOUND` | REJECTED | corrigir payload |
| `WALLET_PLAYER_MISMATCH` | REJECTED | corrigir payload |
| `REFERENCE_NOT_FOUND` | REJECTED | escalar — referência não chegou dentro do limite |
| `REFERENCE_MISMATCH` | REJECTED | corrigir payload |
| `INVALID_REFERENCE_KIND` | REJECTED | corrigir payload |
| `REFERENCE_NOT_PROCESSED` | REJECTED | desistir |
| `REFERENCE_ALREADY_REVERSED` | REJECTED | desistir |
| `REVERSAL_AMOUNT_MISMATCH` | REJECTED | corrigir payload |
| `PROCESSING_ERROR` | FAILED | escalar |

Erros que não viram transação (payload inválido, conflito de idempotência, indisponibilidade) usam códigos de erro HTTP próprios: `INVALID_REQUEST`, `IDEMPOTENCY_CONFLICT`, `WALLET_ALREADY_EXISTS`, `NOT_FOUND`, `TRANSIENT_INFRASTRUCTURE_FAILURE`.

## 7. HTTP

Um único filtro de exceções ([http-support.ts](src/interfaces/http/http-support.ts)) mapeia categorias de erro, consistente em todos os endpoints:

| Situação | Status |
|---|---|
| Payload inválido | 400 `INVALID_REQUEST` |
| Recurso inexistente | 404 |
| Conflito de idempotência / wallet duplicada | 409 |
| Rejeição por regra de negócio | 422 + `failureCode` (é resultado, não exceção) |
| Aceite com processamento pendente | 202 |
| Falha transitória | 503 + `Retry-After` |
| Violação de invariante / inesperado | 500 |

Todo corpo de erro inclui `correlationId`.

## 8. Mensageria

### Consumer SQS ([sqs-wager-consumer.ts](src/interfaces/messaging/sqs-wager-consumer.ts))

- Chama o **mesmo** `SubmitWagerTransactionUseCase`, passando `inboxMessage = {consumerName, messageId}`. O registro de inbox entra na mesma transação SQL que o efeito financeiro; redelivery encontra a inbox/idempotency key e vira replay.
- **Ack (DeleteMessage) só depois que o use case retornou** — ou seja, depois do commit. Morrer entre commit e ack causa redelivery → replay idempotente (testado).
- Classificação:
  - negócio (`REJECTED`, `PENDING_REFERENCE`) → já commitado → **ack**;
  - permanente (JSON inválido, envelope inválido, payload inválido, conflito de idempotência, violação de invariante) → **DLQ imediatamente**, com `failureReason` nos atributos;
  - transitório (todo o resto) → `ChangeMessageVisibility` com backoff `base × 2^(n−1)` (teto 300s); ao atingir `SQS_MAX_RECEIVE_COUNT` → **DLQ** (`retries_exhausted`). O `RedrivePolicy` da fila é a rede de segurança se o processo morrer antes.
- Mensagens do mesmo `MessageGroupId` (wallet) em ordem; grupos diferentes em paralelo.
- **SIGTERM**: `enableShutdownHooks` → `beforeApplicationShutdown` para os workers: o long polling é abortado, mensagens em andamento terminam, as não iniciadas voltam com visibilidade 0. O pool do banco só fecha depois.
- FIFO e deduplicação do SQS são otimização; a garantia é a inbox + `UNIQUE` no banco.

### Transactional Outbox

- Eventos (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`) são gravados em `outbox_messages` **na mesma transação** da mudança financeira. Nada é publicado antes do commit.
- `IntegrationEvent` é classe abstrata; cada evento é subclasse com `eventType` e `version` fixos no tipo. `data` carrega `MoneyProps` (string), nunca a instância.
- Publisher ([publish-outbox.ts](src/application/messaging/publish-outbox.ts)): `SELECT ... FOR UPDATE SKIP LOCKED LIMIT n` → publica → marca `published_at` → commit. Publishers concorrentes pegam lotes disjuntos (testado).
- Crash após publicar e antes do commit: os locks caem, outra instância publica de novo. **O id da mensagem de outbox é o `eventId`**, enviado como `MessageDeduplicationId` (FIFO descarta em 5 min) e disponível para o consumidor deduplicar depois disso (testado).
- Falha de publicação → `scheduleRetry` (1s, 2s, 4s… teto 60s); evento nunca é perdido.
- `MessageGroupId = walletId`: eventos de uma wallet saem em ordem.

## 9. Observabilidade

- **Logs JSON (pino)** com `instance`, `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`. Access log sem corpo; `redact` remove `body/payload/authorization` como defesa adicional. Valores financeiros completos não são logados (apenas status/failureCode).
- **Métricas Prometheus** em `GET /metrics`:
  - `wagering_transactions_total{kind,status}`
  - `wagering_duplicates_detected_total{source=idempotency_replay|inbox}`
  - `wagering_retries_total{operation}`
  - `wagering_dlq_messages_total{reason}`
  - `wagering_lock_conflicts_total`
  - `wagering_outbox_lag_seconds`
  - `wagering_processing_latency_seconds{source=http|sqs|worker}`
  - `wagering_reconciliation_mismatches_total`
  - métricas padrão do processo.
- **Health**: `/health/live` (processo) e `/health/ready` (`SELECT 1` + `GetQueueAttributes`, timeout de 2s cada; 503 se algum falhar). Sem autenticação.
- **Reconciliação** (`POST /wallets/:id/reconciliation`): lê a wallet com `FOR SHARE` (nenhuma escrita intercala) e soma o ledger em `numeric`. Divergência é logada (`error`), contada em métrica e sinalizada na resposta — nunca corrigida.

## 10. Autenticação (não implementada)

Decisão: não implementar, conforme permitido (0 pontos e fora do foco). Ponto de extensão: [`ProviderAuthGuard`](src/interfaces/http/http-support.ts), aplicado aos controllers de wallet e wagering; health e `/metrics` ficam fora.

Desenho previsto:
- **Keycloak** no compose, um client confidencial por provedor (OIDC *client credentials*).
- O guard valida o JWT (assinatura via JWKS em cache, `iss`, `aud`, `exp`) e extrai o claim do provider (ex.: `azp`/claim customizado).
- Regra de domínio: o `providerId` do payload deve ser igual ao do token; caso contrário 403. Isso impede que um provedor submeta ou consulte transações de outro.
- Mensagens da fila seguem como canal interno confiável, mas `providerId` continua passando pelas mesmas validações de domínio.

## 11. Testes

Postgres e LocalStack **reais** em todos os testes de integração e concorrência; os testes criam o banco `wagering_test` e filas próprias.

| Exigência (seção 13) | Onde |
|---|---|
| Money: escala, entradas inválidas, aritmética exata | [money.test.ts](test/unit/money.test.ts) |
| Invariantes da Wallet, ledger imutável | [wallet.test.ts](test/unit/wallet.test.ts) |
| Regras por tipo, máquina de estados, conflito de moeda, payload divergente | [wager-transaction.test.ts](test/unit/wager-transaction.test.ts) |
| Migrations e constraints (SQL direto, sem passar pelo domínio) | [schema-constraints.test.ts](test/integration/schema-constraints.test.ts) |
| Atomicidade wallet/ledger/outbox, replay, conflito, referências fora de ordem | [wagering-use-cases.test.ts](test/integration/wagering-use-cases.test.ts) |
| Inbox e redelivery, crash após commit e antes do ack, DLQ, retry, publishers concorrentes, crash do publisher | [messaging.test.ts](test/integration/messaging.test.ts) |
| 50 apostas iguais em paralelo, cenário 100/80/80, hot wallet, wallets distintas | [in-process-concurrency.test.ts](test/concurrency/in-process-concurrency.test.ts) |
| ≥ 3 processos simultâneos via HTTP | [multi-instance.test.ts](test/concurrency/multi-instance.test.ts) |
| SIGKILL durante o consumo + 3 instâncias novas, consistência final | [restart-recovery.test.ts](test/concurrency/restart-recovery.test.ts) |

Invariante final verificada nos testes: `wallet.balance == saldo reconstruído pelo ledger` (via endpoint/use case de reconciliação).

O único dublê usado é um `UnitOfWork` que sempre lança erro transitório, para provocar o caminho retry → DLQ; a fila nesse teste é real.

## 12. Trade-offs e limitações

- **Throughput por wallet é serializado** pelo lock e pelo `MessageGroupId`. É o preço da correção simples; wallets distintas escalam horizontalmente.
- **O publisher segura os locks das linhas da outbox durante a chamada ao SQS.** Lotes pequenos (10) mantêm a janela curta; a alternativa (lease com `locked_until`) foi descartada por complexidade.
- **`FAILED` está modelado (domínio, schema, taxonomia) mas nenhum fluxo o produz hoje**: falhas transitórias viram retry e falhas permanentes da fila vão para a DLQ com o motivo. Um caminho natural seria marcar `FAILED` ao mover para a DLQ quando a transação já existe.
- **Tabelas `outbox_messages` e `inbox_messages` crescem indefinidamente**; falta um job de limpeza (ex.: apagar publicados/processados com mais de N dias).
- **Métricas são por instância** (cada uma expõe `/metrics`); a agregação fica a cargo do Prometheus.
- **Requisição HTTP pode esperar até 5s** pelo lock de uma hot wallet antes de receber 503.
- Desduplicação de eventos pelo FIFO vale por 5 minutos; depois disso, o consumidor dos eventos precisa deduplicar por `eventId` (contrato documentado, consumidor fora do escopo).
- **Teste de carga (opcional) não foi feito.**
- Ambiente local: o Postgres do compose usa a porta 5433 no host.
