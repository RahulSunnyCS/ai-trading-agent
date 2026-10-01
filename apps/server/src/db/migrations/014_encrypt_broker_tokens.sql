-- Encrypt broker tokens at rest without exposing them to the browser.
-- Existing plaintext rows remain readable; the next successful OAuth login
-- rewrites the row with pgcrypto encryption and sets token_encrypted=true.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE broker_tokens
  ADD COLUMN IF NOT EXISTS token_encrypted BOOLEAN NOT NULL DEFAULT FALSE;
