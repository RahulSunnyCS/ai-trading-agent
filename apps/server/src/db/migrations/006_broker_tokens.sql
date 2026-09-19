-- 006_broker_tokens.sql
-- Stores OAuth access tokens obtained via the in-dashboard broker login flow.
-- One row per broker — the latest successful login overwrites the previous row.
--
-- Why a table (not a file): the API server and the ingestion process share the
-- same Postgres pool; using the DB avoids file-locking issues and works under
-- Docker/Railway where the filesystem may not persist across restarts.

CREATE TABLE IF NOT EXISTS broker_tokens (
  broker          TEXT PRIMARY KEY,
  app_id          TEXT NOT NULL,
  access_token    TEXT NOT NULL,
  refresh_token   TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
