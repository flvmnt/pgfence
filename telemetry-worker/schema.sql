-- pgfence telemetry receiver: D1 schema.
--
-- Apply once:
--   npx wrangler d1 execute pgfence-telemetry --remote --file=./schema.sql
--
-- There is no ip, country, colo, user_agent or headers column, and there is no column
-- that could hold a file path, a table name, a rule id or any SQL. Every column below
-- is an integer or a value drawn from a closed vocabulary enforced in src/validate.ts.

CREATE TABLE IF NOT EXISTS events (
  -- Client-generated uuid. PRIMARY KEY plus INSERT OR IGNORE is what makes the client's
  -- at-least-once delivery idempotent: a run that exits with a request in flight retries
  -- the same batch from a later run, and the retry collapses onto the same row.
  event_id          TEXT    PRIMARY KEY,

  -- Server clock, epoch ms. Authoritative for retention and for every "last N days"
  -- window, because it is the only timestamp a broken or hostile client cannot move.
  received_at       INTEGER NOT NULL,

  -- UTC date derived server-side from received_at, never from client_ts.
  day               TEXT    NOT NULL,

  -- Client clock, epoch ms. Interactive events are delivered by a LATER run, sometimes
  -- days later, so this is the only column that says when the run actually happened.
  -- Used for the weekday/weekend query and for the delivery-lag health check.
  client_ts         INTEGER NOT NULL,

  -- 32 hex, minted by the client from a CSPRNG and derived from nothing.
  install_id        TEXT    NOT NULL,

  -- 1 when the install id was minted during that run. Near-1 populations are ephemeral
  -- containers, not people.
  fresh_install_id  INTEGER NOT NULL,

  command           TEXT    NOT NULL,   -- analyze | trace | explain | snapshot | init
  version           TEXT    NOT NULL,   -- semver, or the literal 'unknown'
  node_major        INTEGER NOT NULL,
  os                TEXT    NOT NULL,   -- closed list, see src/validate.ts
  ci                INTEGER NOT NULL,   -- 0 = interactive or local, 1 = CI detected
  ci_provider       TEXT    NOT NULL,   -- closed list, 'none' when ci = 0
  tty               INTEGER NOT NULL,   -- 1 when stdout was a terminal
  format            TEXT    NOT NULL,   -- sql | typeorm | prisma | knex | drizzle | sequelize | kysely | mixed | none
  rules_mode        TEXT    NOT NULL,   -- default | enable | disable | both
  plugin_count      INTEGER NOT NULL,
  file_count_bucket INTEGER NOT NULL,   -- 0=0, 1=1, 2=2..5, 3=6..20, 4=21..100, 5=>100

  find_safe         INTEGER NOT NULL,
  find_low          INTEGER NOT NULL,
  find_medium       INTEGER NOT NULL,
  find_high         INTEGER NOT NULL,
  find_critical     INTEGER NOT NULL,
  policy_errors     INTEGER NOT NULL,
  policy_warnings   INTEGER NOT NULL,

  errored           INTEGER NOT NULL,   -- 1 when the command's catch block ran
  duration_ms       INTEGER NOT NULL
);

-- Every query in queries.sql filters on received_at and groups by install_id, ci, or a
-- low-cardinality column, so these four cover the whole query set.
CREATE INDEX IF NOT EXISTS events_received_at_idx ON events (received_at);
CREATE INDEX IF NOT EXISTS events_ci_received_idx ON events (ci, received_at);
CREATE INDEX IF NOT EXISTS events_install_day_idx ON events (install_id, day);
CREATE INDEX IF NOT EXISTS events_version_idx     ON events (version);
