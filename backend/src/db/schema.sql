-- LedgerLine schema (idempotent: safe to run on every deploy)
-- Money is NUMERIC(20,4). All arithmetic on balances happens inside PostgreSQL.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- USERS
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'account_holder', 'auditor')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- ACCOUNTS
-- The CHECK constraint is the last line of defence: even a buggy
-- application cannot commit a balance below -overdraft_limit.
-- ============================================================
CREATE TABLE IF NOT EXISTS accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name            TEXT NOT NULL,
  balance         NUMERIC(20,4) NOT NULL DEFAULT 0,
  currency        TEXT NOT NULL DEFAULT 'INR',
  overdraft_limit NUMERIC(20,4) NOT NULL DEFAULT 0 CHECK (overdraft_limit >= 0),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT balance_above_floor CHECK (balance >= -overdraft_limit)
);
CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_id);

CREATE TABLE IF NOT EXISTS account_permissions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  can_deposit  BOOLEAN NOT NULL DEFAULT FALSE,
  can_withdraw BOOLEAN NOT NULL DEFAULT FALSE,
  can_transfer BOOLEAN NOT NULL DEFAULT FALSE,
  can_view     BOOLEAN NOT NULL DEFAULT TRUE,
  granted_by   UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, user_id)
);

-- ============================================================
-- IDEMPOTENCY KEYS
-- Scoped per user. request_hash pins the key to one exact request body,
-- so reusing a key for a different request is rejected, not replayed.
-- The key row is inserted in the SAME database transaction as the money
-- movement, so "key recorded" and "money moved" commit or roll back together.
-- ============================================================
CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id         UUID NOT NULL REFERENCES users(id),
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETE', 'FAILED')),
  response_status INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  PRIMARY KEY (user_id, key)
);

-- Every time a stored key is served again we count it, so "which requests were
-- duplicates" is answerable from the data.
CREATE TABLE IF NOT EXISTS idempotency_replays (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL,
  key         TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- TRANSACTIONS (one row per successful money movement)
-- ============================================================
CREATE TABLE IF NOT EXISTS transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT,
  type            TEXT NOT NULL CHECK (type IN ('DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'ADJUSTMENT')),
  status          TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('COMPLETED')),
  from_account_id UUID REFERENCES accounts(id),
  to_account_id   UUID REFERENCES accounts(id),
  amount          NUMERIC(20,4) NOT NULL CHECK (amount > 0),
  description     TEXT NOT NULL DEFAULT '',
  initiated_by    UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  metadata        JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT transfer_distinct CHECK (from_account_id IS NULL OR to_account_id IS NULL OR from_account_id <> to_account_id)
);
CREATE INDEX IF NOT EXISTS idx_tx_from ON transactions(from_account_id);
CREATE INDEX IF NOT EXISTS idx_tx_to ON transactions(to_account_id);
CREATE INDEX IF NOT EXISTS idx_tx_created ON transactions(created_at);

-- ============================================================
-- LEDGER ENTRIES  (double-entry, append-only, hash-chained)
-- ============================================================
CREATE TABLE IF NOT EXISTS ledger_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             BIGSERIAL UNIQUE,
  transaction_id  UUID NOT NULL REFERENCES transactions(id),
  account_id      UUID NOT NULL REFERENCES accounts(id),
  entry_type      TEXT NOT NULL CHECK (entry_type IN ('DEBIT', 'CREDIT')),
  amount          NUMERIC(20,4) NOT NULL CHECK (amount > 0),
  running_balance NUMERIC(20,4) NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  initiated_by    UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  prev_hash       TEXT,
  entry_hash      TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_account_seq ON ledger_entries(account_id, seq);
CREATE INDEX IF NOT EXISTS idx_ledger_tx ON ledger_entries(transaction_id);

-- Hash chain per account, computed by the DATABASE (not the app) on insert.
-- Editing any historical row (even with the immutability trigger disabled by a
-- superuser) breaks the chain, which the ledger_chain_check view reports.
CREATE OR REPLACE FUNCTION ledger_set_hash() RETURNS TRIGGER AS $$
DECLARE prev TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.account_id::text, 0));
  SELECT entry_hash INTO prev FROM ledger_entries
    WHERE account_id = NEW.account_id ORDER BY seq DESC LIMIT 1;
  NEW.prev_hash := COALESCE(prev, repeat('0', 64));
  NEW.entry_hash := encode(digest(concat_ws('|',
      NEW.prev_hash, NEW.transaction_id, NEW.account_id, NEW.entry_type,
      NEW.amount::text, NEW.running_balance::text, NEW.initiated_by), 'sha256'), 'hex');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_hash_chain ON ledger_entries;
CREATE TRIGGER ledger_hash_chain BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_set_hash();

-- ============================================================
-- REFUSED ATTEMPTS (append-only)
-- ============================================================
CREATE TABLE IF NOT EXISTS refused_attempts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID REFERENCES accounts(id),
  attempted_by       UUID NOT NULL REFERENCES users(id),
  operation          TEXT NOT NULL,
  amount             NUMERIC(20,4),
  reason             TEXT NOT NULL,
  reason_code        TEXT NOT NULL DEFAULT 'REFUSED',
  balance_at_attempt NUMERIC(20,4),
  idempotency_key    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata           JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_refused_account ON refused_attempts(account_id, created_at);

-- ============================================================
-- AUDIT LOG (append-only)
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id),
  action      TEXT NOT NULL,
  resource    TEXT,
  resource_id UUID,
  details     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- ============================================================
-- APPEND-ONLY ENFORCEMENT (UPDATE, DELETE and TRUNCATE all blocked)
-- ============================================================
CREATE OR REPLACE FUNCTION prevent_modification() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only. Attempted % is not allowed.', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_ledger_immutability ON ledger_entries;
CREATE TRIGGER enforce_ledger_immutability BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION prevent_modification();
DROP TRIGGER IF EXISTS enforce_ledger_no_truncate ON ledger_entries;
CREATE TRIGGER enforce_ledger_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_modification();

DROP TRIGGER IF EXISTS enforce_refused_immutability ON refused_attempts;
CREATE TRIGGER enforce_refused_immutability BEFORE UPDATE OR DELETE ON refused_attempts
  FOR EACH ROW EXECUTE FUNCTION prevent_modification();
DROP TRIGGER IF EXISTS enforce_refused_no_truncate ON refused_attempts;
CREATE TRIGGER enforce_refused_no_truncate BEFORE TRUNCATE ON refused_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_modification();

DROP TRIGGER IF EXISTS enforce_audit_immutability ON audit_log;
CREATE TRIGGER enforce_audit_immutability BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_modification();
DROP TRIGGER IF EXISTS enforce_audit_no_truncate ON audit_log;
CREATE TRIGGER enforce_audit_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION prevent_modification();

DROP TRIGGER IF EXISTS enforce_tx_immutability ON transactions;
CREATE TRIGGER enforce_tx_immutability BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION prevent_modification();

-- ============================================================
-- PROOF VIEWS
-- ============================================================
-- 1. Sum of ledger postings equals sum of balances.
CREATE OR REPLACE VIEW conservation_check AS
SELECT
  COALESCE((SELECT SUM(CASE WHEN entry_type = 'CREDIT' THEN amount ELSE -amount END) FROM ledger_entries), 0) AS ledger_net,
  COALESCE((SELECT SUM(balance) FROM accounts), 0) AS total_balance_sum;

-- 2. Every account balance equals the sum of its own postings.
CREATE OR REPLACE VIEW account_balance_mismatches AS
SELECT a.id AS account_id, a.balance,
       COALESCE(SUM(CASE WHEN le.entry_type = 'CREDIT' THEN le.amount ELSE -le.amount END), 0) AS ledger_balance
FROM accounts a LEFT JOIN ledger_entries le ON le.account_id = a.id
GROUP BY a.id, a.balance
HAVING a.balance <> COALESCE(SUM(CASE WHEN le.entry_type = 'CREDIT' THEN le.amount ELSE -le.amount END), 0);

-- 3. Every transfer has exactly two postings that net to zero.
CREATE OR REPLACE VIEW unbalanced_transfers AS
SELECT t.id AS transaction_id
FROM transactions t JOIN ledger_entries le ON le.transaction_id = t.id
WHERE t.type = 'TRANSFER'
GROUP BY t.id
HAVING COUNT(*) <> 2 OR SUM(CASE WHEN le.entry_type = 'CREDIT' THEN le.amount ELSE -le.amount END) <> 0;

-- 4. Hash chain verification: lists every entry whose chain link or hash is wrong.
CREATE OR REPLACE VIEW ledger_chain_check AS
SELECT id AS entry_id, account_id, seq FROM (
  SELECT le.*,
         LAG(le.entry_hash) OVER (PARTITION BY le.account_id ORDER BY le.seq) AS expected_prev
  FROM ledger_entries le
) x
WHERE prev_hash IS DISTINCT FROM COALESCE(expected_prev, repeat('0', 64))
   OR entry_hash IS DISTINCT FROM encode(digest(concat_ws('|',
        prev_hash, transaction_id, account_id, entry_type,
        amount::text, running_balance::text, initiated_by), 'sha256'), 'hex');
