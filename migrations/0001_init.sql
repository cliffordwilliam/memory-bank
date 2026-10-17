-- Memory bank schema. See docs/spec.md §5 for the design.
--
-- Names are branches, records are commits: every record belongs to one name,
-- and the order of ids within a name is its history. Claude can only add and
-- read (the server has no UPDATE or DELETE statements). The triggers below make
-- deletes and changes to ids, names, times and correction links impossible for
-- everyone; the only updates they allow are the owner's admin edits (spec §10).

-- The kinds of names. Descriptions are shown to Claude in the tool definitions,
-- so this table is the only place a type is defined.
CREATE TABLE types (
  name        TEXT PRIMARY KEY,
  description TEXT NOT NULL
) STRICT;

-- One row per name (topic). A name is created once, with its type.
CREATE TABLE names (
  name        TEXT PRIMARY KEY
              CHECK (length(name) BETWEEN 1 AND 64
                     AND name NOT GLOB '*[^a-z0-9-]*'),
  type        TEXT NOT NULL REFERENCES types(name),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  modified_at TEXT  -- set by trigger when the owner changes the type
) STRICT;

-- One row per memory.
CREATE TABLE records (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,  -- never reused; gives the chain order
  name            TEXT NOT NULL REFERENCES names(name),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),  -- when saved, UTC
  -- When it happened, exactly as Claude sent it: wall-clock time with an offset.
  occurred_at     TEXT NOT NULL
                  CHECK (occurred_at GLOB '*Z'
                         OR occurred_at GLOB '*[+-][0-9][0-9]:[0-9][0-9]'),
  -- Derived UTC copy, used for sorting and filtering. NULL (so refused) when
  -- occurred_at isn't a time SQLite can read.
  occurred_at_utc TEXT NOT NULL
                  GENERATED ALWAYS AS (strftime('%Y-%m-%dT%H:%M:%fZ', occurred_at)) STORED,
  modified_at     TEXT,  -- set by trigger when the owner redacts the text
  description     TEXT NOT NULL
                  CHECK (length(description) BETWEEN 1 AND 200
                         AND instr(description, char(10)) = 0
                         AND instr(description, char(13)) = 0),
  body            TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 16000),
  corrects        INTEGER UNIQUE REFERENCES records(id),  -- the record this one says was wrong
  kind            TEXT CHECK (kind IN ('correction', 'retraction')),
  CHECK ((corrects IS NULL) = (kind IS NULL))
) STRICT;

CREATE INDEX records_name_id   ON records(name, id);
CREATE INDEX records_name_time ON records(name, occurred_at_utc);
CREATE INDEX records_time      ON records(occurred_at_utc);

-- Full-text index over the text Claude wrote. External content: the index
-- reads the text from `records` and stores no second copy of it.
CREATE VIRTUAL TABLE records_fts USING fts5(
  name, description, body,
  content = 'records', content_rowid = 'id',
  tokenize = 'porter unicode61 remove_diacritics 2'
);

-- Keep the index in step with new records.
CREATE TRIGGER records_fts_insert AFTER INSERT ON records BEGIN
  INSERT INTO records_fts (rowid, name, description, body)
  VALUES (new.id, new.name, new.description, new.body);
END;

-- A redaction (the owner editing the text) refreshes the index entry and
-- stamps modified_at.
CREATE TRIGGER records_redact AFTER UPDATE OF description, body ON records BEGIN
  INSERT INTO records_fts (records_fts, rowid, name, description, body)
  VALUES ('delete', old.id, old.name, old.description, old.body);
  INSERT INTO records_fts (rowid, name, description, body)
  VALUES (new.id, new.name, new.description, new.body);
  UPDATE records SET modified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = new.id;
END;

-- A correction must point to an existing record of the same name. The record
-- being inserted doesn't exist yet, so it can't correct itself.
CREATE TRIGGER records_corrects_same_name BEFORE INSERT ON records
WHEN new.corrects IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'corrects: must point to an existing record of the same name')
  WHERE NOT EXISTS (SELECT 1 FROM records WHERE id = new.corrects AND name = new.name);
END;

-- Nothing is ever deleted.
CREATE TRIGGER records_no_delete BEFORE DELETE ON records BEGIN
  SELECT RAISE(ABORT, 'append-only: records can''t be deleted');
END;
CREATE TRIGGER names_no_delete BEFORE DELETE ON names BEGIN
  SELECT RAISE(ABORT, 'append-only: names can''t be deleted');
END;
CREATE TRIGGER types_no_delete BEFORE DELETE ON types BEGIN
  SELECT RAISE(ABORT, 'append-only: types can''t be deleted');
END;

-- Ids, names, times and correction links never change.
-- (occurred_at_utc is generated, so SQLite refuses to write it at all.)
CREATE TRIGGER records_frozen
BEFORE UPDATE OF id, name, created_at, occurred_at, corrects, kind ON records BEGIN
  SELECT RAISE(ABORT, 'append-only: only a record''s description and body can be edited');
END;

-- A name and its creation time never change; the owner may change its type.
CREATE TRIGGER names_frozen BEFORE UPDATE OF name, created_at ON names BEGIN
  SELECT RAISE(ABORT, 'append-only: only a name''s type can be changed');
END;
CREATE TRIGGER names_retype AFTER UPDATE OF type ON names BEGIN
  UPDATE names SET modified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE name = new.name;
END;

-- A type's name never changes; the owner may reword its description.
CREATE TRIGGER types_frozen BEFORE UPDATE OF name ON types BEGIN
  SELECT RAISE(ABORT, 'append-only: only a type''s description can be changed');
END;

INSERT INTO types (name, description) VALUES
  ('user',      'Lasting facts about the user: background, tastes, health conditions, current medication list. Not dated happenings (log) and not rules for Claude (feedback). Each new record restates the whole current fact.'),
  ('feedback',  'Rules for how Claude should respond or work: corrections, style rules, approaches the user confirmed. Phrased as an instruction to Claude. Each new record restates the whole rule.'),
  ('project',   'An ongoing effort: goal, decisions, status, next steps. The latest record is the current state, so each new record restates the whole current state, not just the change.'),
  ('reference', 'Material to keep and look up later: recipes, instructions, how-tos, where things are. One specific name per item (vanilla-cupcakes, not cupcake-recipe). Each new record is the whole new version.'),
  ('log',       'Things that happened, one record per occurrence: a meal, a dose, a workout, a symptom. Reuse the series'' existing name (meals, medication).');
