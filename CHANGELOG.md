# Changelog

## 0.4.0 (2026-03-14)

### Trace Mode (new)

Run your migrations against a real Postgres instance and verify every lock prediction:

```bash
pgfence trace migrations/*.sql
```

- Spins up a disposable Docker container (`postgres:{version}-alpine` or custom image)
- Executes each statement and queries `pg_locks` + system catalog after every step
- Diffs catalog snapshots to detect table rewrites (`relfilenode` changes), column modifications, constraint validation state, and index creation
- Merges static analysis predictions with trace observations, producing a verification status for each check: `confirmed`, `mismatch`, `trace-only`, `static-only`, `error`
- Observer connection polls `pg_locks` during `CONCURRENTLY` statements to capture transient locks that other tools skip entirely
- `--pg-version` targets specific Postgres versions (default: 17)
- `--docker-image` supports custom images (PostGIS, pgvector, TimescaleDB)
- `--ci` fails on mismatches, execution errors, or risk threshold violations
- Color-coded CLI reporter with verification status, duration, and trace-only findings section

### Security

- `sanitizeError` now covers both `postgres://` and `postgresql://` URL schemes
- `snapshot` command error handler calls `sanitizeError()` (was missing, could leak credentials in CI logs)
- Plugin loader rejects paths resolving outside the project directory (prevents code execution via malicious `.pgfence.json`)
- `stopContainer` wrapped in try/catch so failures in `finally` blocks no longer suppress the original error or leak container references
- Container password passed to Docker is ephemeral (random 20-char base64url, never written to disk)
- Container binds to `127.0.0.1` only

### Trust Contract Fixes

- **trace-only findings**: risk is now derived from the observed lock mode (was hard-coded to `LOW` regardless of actual lock, allowing ACCESS EXCLUSIVE locks to pass `--max-risk=medium`)
- **mismatch findings**: risk is upgraded to `max(static, trace-derived)` when trace observes a stronger lock (was keeping the static risk, allowing dangerous migrations through CI)
- **trace-error entries**: synthetic entries for failed statements now risk `MEDIUM` (was `SAFE`, displaying as green in the reporter)
- **CI error check**: trace `--ci` now fails on `errors > 0` (was only checking mismatches)

### Reporter Improvements

- Error and cascade-error rows display `ERROR` in the risk column instead of the placeholder `SAFE` / `ACCESS SHARE`
- Dedicated "Execution Errors" section shows the actual error message for each failed statement
- `cascade-error` uses red coloring (was dim gray, indistinct from `static-only`)
- `tableRewrite: false` preserved in output (was coerced to `undefined`, losing the "confirmed no rewrite" signal)

### Rules

- Default minimum PostgreSQL version bumped from 11 to 14
- `rename-column` uses `config.minPostgresVersion`: no expand/contract recipe shown on PG14+ where RENAME is instant
- Removed stale "PG10 and below" note from ADD COLUMN constant default safe rewrite
- Removed "PG12+" qualifiers from SET NOT NULL and REINDEX safe rewrites (unnecessary now that minimum is PG14)
- Removed phantom `TriggerChange` / `EnumChange` interfaces that were declared but never populated

### Session Isolation

- `RESET ALL` issued between file traces to prevent session state leakage (search_path, timeouts set by one migration file no longer affect subsequent files)

### Code Quality

- Fixed FK message: "SHARE lock" corrected to "SHARE ROW EXCLUSIVE lock" on referenced table
- Fixed ATTACH PARTITION lock mode for PG12+ (SHARE_UPDATE_EXCLUSIVE, was ACCESS_EXCLUSIVE)
- Fixed REINDEX TABLE lock (SHARE, was ACCESS_EXCLUSIVE)
- Fixed `lock_timeout=0` detection (protobuf `ival.ival ?? 0` fix)
- Removed em dashes from all user-visible strings
- GitHub PR reporter URL corrected
- Extractor silent failures fixed in knex-transpiler and sequelize-transpiler

### Tests

- 371 tests (was 176 in 0.3.2)
- New test suites: `tracer.test.ts`, `trace-merge.test.ts`, `trace-cli.test.ts`
- Risk derivation tests for trace-only, mismatch, no-downgrade, and trace-error scenarios
- Error and cascade-error reporter rendering tests

## 0.3.2 (2026-03-08)

- Fixed ADD CONSTRAINT lock modes (SHARE ROW EXCLUSIVE, was ACCESS EXCLUSIVE)
- Fixed USING INDEX variants (SHARE UPDATE EXCLUSIVE)
- Added validate-constraint, add-pk-without-using-index, missing-idle-timeout tests

## 0.3.1 (2026-03-07)

- Fixed CREATE TRIGGER lock mode (SHARE ROW EXCLUSIVE, was ACCESS EXCLUSIVE)
- Fixed REFRESH MATVIEW CONCURRENTLY lock mode (EXCLUSIVE, was SHARE UPDATE EXCLUSIVE)
- Fixed ALTER TYPE ADD VALUE lock mode on PG12+ (EXCLUSIVE, was SHARE UPDATE EXCLUSIVE)

## 0.3.0 (2026-03-06)

- VS Code extension (LSP client)
- LSP server: diagnostics, code actions (safe rewrites), hover info
- 5 new rules: ban-char-field, prefer-identity, DROP DATABASE, ALTER DOMAIN, CREATE DOMAIN
- Inline `-- pgfence-ignore` comments
- Schema snapshot support for definitive type analysis

## 0.2.0 (2026-02-28)

- DB-size-aware risk scoring via `--db-url` and `--stats-file`
- GitHub PR comment reporter
- SARIF output format
- Plugin system for custom rules
- 6 ORM extractors: SQL, TypeORM, Prisma, Knex, Drizzle, Sequelize

## 0.1.0 (2026-02-20)

- Initial release
- 15 DDL checks with lock mode analysis
- Safe rewrite recipes
- CLI and JSON output
- Policy checks (lock_timeout, statement_timeout, CONCURRENTLY in tx)
