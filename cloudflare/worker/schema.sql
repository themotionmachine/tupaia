-- D1 schema for the Tier-A collaborative map (fmg-meta).
-- One row per map. The multi-MB .map blob lives in R2, never here (PRD §6).
-- Source of truth, committed on purpose (NFR-1) — apply with:
--   wrangler d1 execute fmg-meta --remote --file=cloudflare/worker/schema.sql

CREATE TABLE IF NOT EXISTS map (
  id           TEXT PRIMARY KEY,            -- short slug, e.g. "shared"
  name         TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 0,  -- monotonically incremented per save
  updated_at   TEXT NOT NULL,              -- ISO timestamp
  updated_by   TEXT NOT NULL,              -- Cf-Access-Authenticated-User-Email
  -- soft advisory lock (Tier-A guardrail, honored by convention, not enforced):
  editing_by   TEXT,
  lock_expires TEXT
);
