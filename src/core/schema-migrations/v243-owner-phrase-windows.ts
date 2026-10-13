import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Owner phrases (src/core/mentions/owner-phrase/, docs/guides/owner-phrases.md):
//   - links.link_kind widens to 'owner_phrase': owner-phrase links stay
//     link_source='mentions', so every ranking reader that excludes mentions
//     excludes them too. The CHECK is replaced under its default name
//     (links_link_kind_check, the name both the v101 column add and the
//     fresh-install inline CHECK get); existing rows satisfy the wider list.
//   - owner_phrase_page_state: per page, the content revision and scan version
//     its cue lines, self-declared descriptors, owner phrases and date readings
//     were scanned at.
//   - owner_phrase_windows: one row per (identity group, owner) stint with its
//     inclusive bounds and evidence pages; never page_aliases.
//   - owner_phrase_status: one row per source (state, generation, window hash,
//     firing counters).
// Off by default (`mentions.owner_phrases`); the tables stay empty until the
// mention pass runs with the key on.
export const v243: Migration = {
  version: 243,
  name: 'owner_phrase_windows',
  idempotent: true,
  sql: `
    ALTER TABLE links DROP CONSTRAINT IF EXISTS links_link_kind_check;
    ALTER TABLE links ADD CONSTRAINT links_link_kind_check
      CHECK (link_kind IS NULL OR link_kind IN ('plain', 'typed_ner', 'owner_phrase'));
    CREATE TABLE IF NOT EXISTS owner_phrase_page_state (
      page_id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      revision UUID,
      version INTEGER NOT NULL,
      page_date DATE,
      readings TEXT[] NOT NULL DEFAULT '{}',
      agent BOOLEAN NOT NULL DEFAULT false,
      cues JSONB NOT NULL DEFAULT '[]'::jsonb,
      descriptors TEXT[] NOT NULL DEFAULT '{}',
      hits JSONB NOT NULL DEFAULT '[]'::jsonb,
      statements JSONB,
      statements_key TEXT,
      scanned_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE owner_phrase_page_state ADD COLUMN IF NOT EXISTS statements JSONB;
    ALTER TABLE owner_phrase_page_state ADD COLUMN IF NOT EXISTS statements_key TEXT;
    CREATE INDEX IF NOT EXISTS owner_phrase_page_state_source_idx ON owner_phrase_page_state (source_id);
    CREATE TABLE IF NOT EXISTS owner_phrase_windows (
      id BIGSERIAL PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      group_key TEXT NOT NULL,
      account_slugs TEXT[] NOT NULL,
      owner_key TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      descriptors TEXT[] NOT NULL DEFAULT '{}',
      valid_from DATE,
      valid_to DATE,
      start_known BOOLEAN NOT NULL,
      evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
      evidence_page_ids INTEGER[] NOT NULL DEFAULT '{}',
      private_page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
      generation BIGINT NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS owner_phrase_windows_group_idx ON owner_phrase_windows (source_id, group_key);
    CREATE INDEX IF NOT EXISTS owner_phrase_windows_accounts_idx ON owner_phrase_windows USING GIN (account_slugs);
    CREATE TABLE IF NOT EXISTS owner_phrase_status (
      source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK (state IN ('complete','pending','failed')),
      generation BIGINT NOT NULL DEFAULT 0,
      window_hash TEXT,
      inputs_hash TEXT,
      windows INTEGER NOT NULL DEFAULT 0,
      links INTEGER NOT NULL DEFAULT 0,
      documents INTEGER NOT NULL DEFAULT 0,
      unresolved INTEGER NOT NULL DEFAULT 0,
      ambiguous INTEGER NOT NULL DEFAULT 0,
      last_pass_at TIMESTAMPTZ,
      error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE owner_phrase_status ADD COLUMN IF NOT EXISTS inputs_hash TEXT;
    DO $rls$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolbypassrls) THEN
        ALTER TABLE owner_phrase_page_state ENABLE ROW LEVEL SECURITY;
        ALTER TABLE owner_phrase_windows ENABLE ROW LEVEL SECURITY;
        ALTER TABLE owner_phrase_status ENABLE ROW LEVEL SECURITY;
      END IF;
    END $rls$;
  `,
};
