import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial. As invariantes da seção 6 são garantidas aqui, não só na aplicação:
 *
 * - wallets: UNIQUE(player_id, currency), CHECK(balance >= 0);
 * - wager_transactions: unicidade por (provider, idempotency_key) e (provider, external_id),
 *   reversão única por referência (índice parcial), status terminal imutável (trigger);
 * - wallet_ledger_entries: append-only (trigger bloqueia UPDATE/DELETE/TRUNCATE), aritmética
 *   via CHECK, uma entrada por (transação, wallet) e por (wallet, versão), encadeamento
 *   balance_before = balance_after anterior;
 * - consistência saldo ↔ ledger e transação ↔ ledger verificada no COMMIT (constraint triggers deferred).
 *
 * FKs são DEFERRABLE INITIALLY DEFERRED: a ordem de INSERT dentro da transação não importa,
 * só o estado no commit.
 */
export class Migration20261107000000InitialSchema extends Migration {
  override async up(): Promise<void> {
    // ------------------------------------------------------------------ wallets
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid           PRIMARY KEY,
        player_id   varchar(128)   NOT NULL,
        currency    char(3)        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
        balance     numeric(19,2)  NOT NULL CHECK (balance >= 0),
        version     integer        NOT NULL CHECK (version >= 1),
        created_at  timestamptz    NOT NULL,
        updated_at  timestamptz    NOT NULL,
        CONSTRAINT wallets_player_currency_unique UNIQUE (player_id, currency),
        CONSTRAINT wallets_id_currency_unique     UNIQUE (id, currency)
      );
    `);

    // ------------------------------------------------------------------ wager_transactions
    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                 uuid           PRIMARY KEY,
        provider_id                        varchar(128)   NOT NULL,
        external_transaction_id            varchar(256)   NOT NULL,
        idempotency_key                    varchar(512)   NOT NULL,
        payload_hash                       varchar(64)    NOT NULL,
        wallet_id                          uuid           NOT NULL,
        player_id                          varchar(128)   NOT NULL,
        round_id                           varchar(256)   NOT NULL,
        game_id                            varchar(256)   NOT NULL,
        kind                               varchar(16)    NOT NULL
          CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                             numeric(19,2)  NOT NULL CHECK (amount >= 0),
        currency                           char(3)        NOT NULL,
        reference_external_transaction_id  varchar(256),
        reference_transaction_id           uuid
          REFERENCES wager_transactions (id) DEFERRABLE INITIALLY DEFERRED,
        status                             varchar(24)    NOT NULL
          CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                       varchar(64),
        resulting_balance                  numeric(19,2),
        reference_resolution_attempts      integer        NOT NULL DEFAULT 0 CHECK (reference_resolution_attempts >= 0),
        next_reference_resolution_at       timestamptz,
        correlation_id                     varchar(128)   NOT NULL,
        created_at                         timestamptz    NOT NULL,
        processed_at                       timestamptz,

        CONSTRAINT wager_tx_provider_idempotency_unique UNIQUE (provider_id, idempotency_key),
        CONSTRAINT wager_tx_provider_external_unique    UNIQUE (provider_id, external_transaction_id),
        CONSTRAINT wager_tx_reversal_requires_reference
          CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL),
        CONSTRAINT wager_tx_failure_code_iff_rejected_or_failed
          CHECK ((status IN ('REJECTED','FAILED')) = (failure_code IS NOT NULL)),
        CONSTRAINT wager_tx_processed_at_iff_terminal
          CHECK ((status IN ('PROCESSED','REJECTED','FAILED')) = (processed_at IS NOT NULL)),
        CONSTRAINT wager_tx_schedule_iff_pending_reference
          CHECK ((status = 'PENDING_REFERENCE') = (next_reference_resolution_at IS NOT NULL))
      );
    `);

    // Regra 4: uma referência é revertida no máximo uma vez (REFUND e ROLLBACK somados).
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_reversal_per_reference
        ON wager_transactions (reference_transaction_id)
        WHERE kind IN ('REFUND','ROLLBACK') AND status = 'PROCESSED';
    `);
    this.addSql(`
      CREATE UNIQUE INDEX wager_tx_single_opening_per_wallet
        ON wager_transactions (wallet_id) WHERE kind = 'OPENING';
    `);
    this.addSql(`
      CREATE INDEX wager_tx_pending_reference_due
        ON wager_transactions (next_reference_resolution_at) WHERE status = 'PENDING_REFERENCE';
    `);
    this.addSql(`
      CREATE INDEX wager_tx_pending_by_reference
        ON wager_transactions (wallet_id, provider_id, reference_external_transaction_id)
        WHERE status = 'PENDING_REFERENCE';
    `);

    // Campos do pedido são imutáveis; status terminal não muda.
    this.addSql(`
      CREATE FUNCTION wager_tx_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.status IN ('PROCESSED','REJECTED','FAILED') THEN
          RAISE EXCEPTION 'wager_transaction % is terminal (%)', OLD.id, OLD.status USING ERRCODE = 'check_violation';
        END IF;
        IF (NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key, NEW.payload_hash, NEW.wallet_id,
            NEW.player_id, NEW.round_id, NEW.game_id, NEW.kind, NEW.amount, NEW.currency,
            NEW.reference_external_transaction_id, NEW.created_at)
           IS DISTINCT FROM
           (OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key, OLD.payload_hash, OLD.wallet_id,
            OLD.player_id, OLD.round_id, OLD.game_id, OLD.kind, OLD.amount, OLD.currency,
            OLD.reference_external_transaction_id, OLD.created_at) THEN
          RAISE EXCEPTION 'wager_transaction % request fields are immutable', OLD.id USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER wager_tx_guard_update BEFORE UPDATE ON wager_transactions
        FOR EACH ROW EXECUTE FUNCTION wager_tx_guard_update();
    `);

    // ------------------------------------------------------------------ wallet_ledger_entries
    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id              uuid           PRIMARY KEY,
        wallet_id       uuid           NOT NULL,
        transaction_id  uuid           NOT NULL REFERENCES wager_transactions (id) DEFERRABLE INITIALLY DEFERRED,
        wallet_version  integer        NOT NULL CHECK (wallet_version >= 1),
        direction       varchar(6)     NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount          numeric(19,2)  NOT NULL CHECK (amount > 0),
        balance_before  numeric(19,2)  NOT NULL CHECK (balance_before >= 0),
        balance_after   numeric(19,2)  NOT NULL CHECK (balance_after >= 0),
        currency        char(3)        NOT NULL,
        created_at      timestamptz    NOT NULL,

        CONSTRAINT ledger_wallet_currency_fk FOREIGN KEY (wallet_id, currency)
          REFERENCES wallets (id, currency) DEFERRABLE INITIALLY DEFERRED,
        CONSTRAINT ledger_one_entry_per_transaction_wallet UNIQUE (transaction_id, wallet_id),
        CONSTRAINT ledger_one_entry_per_wallet_version     UNIQUE (wallet_id, wallet_version),
        CONSTRAINT ledger_arithmetic CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      );
    `);

    // Append-only.
    this.addSql(`
      CREATE FUNCTION ledger_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only (% blocked)', TG_OP USING ERRCODE = 'restrict_violation';
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_update_delete BEFORE UPDATE OR DELETE ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
    `);
    this.addSql(`
      CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON wallet_ledger_entries
        FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_mutation();
    `);

    // Encadeamento: versão sequencial e balance_before = balance_after da entrada anterior.
    this.addSql(`
      CREATE FUNCTION ledger_assert_chain() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE previous_entry RECORD;
      BEGIN
        SELECT wallet_version, balance_after INTO previous_entry
          FROM wallet_ledger_entries
         WHERE wallet_id = NEW.wallet_id AND wallet_version < NEW.wallet_version
         ORDER BY wallet_version DESC LIMIT 1;

        IF NOT FOUND THEN
          IF NEW.balance_before <> 0 THEN
            RAISE EXCEPTION 'first ledger entry of wallet % must start at 0', NEW.wallet_id USING ERRCODE = 'check_violation';
          END IF;
        ELSIF NEW.wallet_version <> previous_entry.wallet_version + 1
           OR NEW.balance_before <> previous_entry.balance_after THEN
          RAISE EXCEPTION 'ledger chain broken for wallet % at version %', NEW.wallet_id, NEW.wallet_version
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END $$;
    `);
    this.addSql(`
      CREATE TRIGGER ledger_assert_chain BEFORE INSERT ON wallet_ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_assert_chain();
    `);

    // No COMMIT: saldo e versão da wallet = última entrada do ledger (ou 0 sem entradas).
    this.addSql(`
      CREATE FUNCTION wallet_assert_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE current_wallet RECORD; latest_entry RECORD;
      BEGIN
        SELECT balance, version INTO current_wallet FROM wallets WHERE id = NEW.id;
        SELECT balance_after, wallet_version INTO latest_entry
          FROM wallet_ledger_entries WHERE wallet_id = NEW.id
         ORDER BY wallet_version DESC LIMIT 1;

        IF NOT FOUND THEN
          IF current_wallet.balance <> 0 THEN
            RAISE EXCEPTION 'wallet % has balance without ledger entries', NEW.id USING ERRCODE = 'check_violation';
          END IF;
        ELSIF latest_entry.balance_after <> current_wallet.balance
           OR latest_entry.wallet_version <> current_wallet.version THEN
          RAISE EXCEPTION 'wallet % diverges from ledger', NEW.id USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER wallet_matches_ledger AFTER INSERT OR UPDATE ON wallets
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION wallet_assert_matches_ledger();
    `);

    // No COMMIT: transação tem lançamento ⇔ PROCESSED e kind ≠ LOSS.
    this.addSql(`
      CREATE FUNCTION transaction_assert_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE checked_transaction_id uuid; current_transaction RECORD; has_entry boolean;
      BEGIN
        IF TG_TABLE_NAME = 'wallet_ledger_entries' THEN
          checked_transaction_id := NEW.transaction_id;
        ELSE
          checked_transaction_id := NEW.id;
        END IF;

        SELECT status, kind INTO current_transaction FROM wager_transactions WHERE id = checked_transaction_id;
        SELECT EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = checked_transaction_id) INTO has_entry;

        IF has_entry <> (current_transaction.status = 'PROCESSED' AND current_transaction.kind <> 'LOSS') THEN
          RAISE EXCEPTION 'transaction % (% %) inconsistent with ledger (has_entry=%)',
            checked_transaction_id, current_transaction.kind, current_transaction.status, has_entry
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NULL;
      END $$;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER transaction_matches_ledger AFTER INSERT OR UPDATE ON wager_transactions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION transaction_assert_matches_ledger();
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ledger_matches_transaction AFTER INSERT ON wallet_ledger_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION transaction_assert_matches_ledger();
    `);

    // ------------------------------------------------------------------ inbox / outbox
    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name  varchar(128)  NOT NULL,
        message_id     varchar(256)  NOT NULL,
        payload_hash   varchar(64)   NOT NULL,
        received_at    timestamptz   NOT NULL,
        processed_at   timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id               uuid          PRIMARY KEY,
        aggregate_id     varchar(128)  NOT NULL,
        event_type       varchar(128)  NOT NULL,
        payload          jsonb         NOT NULL,
        occurred_at      timestamptz   NOT NULL,
        attempts         integer       NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at  timestamptz,
        published_at     timestamptz,
        last_error       text
      );
    `);
    this.addSql(`
      CREATE INDEX outbox_pending_due ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;');
    this.addSql('DROP TABLE IF EXISTS inbox_messages;');
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;');
    this.addSql('DROP TABLE IF EXISTS wager_transactions;');
    this.addSql('DROP TABLE IF EXISTS wallets;');
    this.addSql('DROP FUNCTION IF EXISTS transaction_assert_matches_ledger();');
    this.addSql('DROP FUNCTION IF EXISTS wallet_assert_matches_ledger();');
    this.addSql('DROP FUNCTION IF EXISTS ledger_assert_chain();');
    this.addSql('DROP FUNCTION IF EXISTS ledger_reject_mutation();');
    this.addSql('DROP FUNCTION IF EXISTS wager_tx_guard_update();');
  }
}
