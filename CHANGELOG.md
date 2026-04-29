# Changelog

## 0.5.0 (2026-04-29)

### Trust Contract

- **Fail-closed ORM extraction**: Knex, Sequelize, TypeORM, Drizzle, and raw SQL extraction paths now surface more unanalyzable statements instead of silently treating partially reconstructed migrations as complete.
- **Coverage line across reporters**: CLI, JSON, GitHub PR markdown, SARIF, and GitLab Code Quality output now report analyzed statement counts and unanalyzable statement counts more consistently.
- **Unanalyzable SQL is visible in review**: GitHub PR output no longer presents a file with unanalyzable statements as simply safe. The report calls out the gap and keeps the coverage summary visible.
- **Policy edge cases hardened**: transaction state, missing policy statements, timeout ordering, and unsafe special operations in transactions have broader test coverage and clearer behavior.

### Analyzer And Rules

- Added stronger coverage for compounding lock windows, new-table visibility, schema collisions, unsafe destructive statements, tautological `DELETE` and `UPDATE` patterns, incomplete foreign key metadata, and concurrent special operations inside transactions.
- Improved handling for generated columns, serial-style additions, JSON defaults, enum ordering, partition operations, renames, reindex operations, and type-change classification.
- Added table-reference helpers and schema-snapshot handling used by rules that need better context.

### Extractors

- Knex extraction now fails closed for incomplete `references()` metadata, dynamic builder paths, conditional raw SQL, and transaction configuration cases.
- Sequelize extraction now fails closed for dynamic foreign key metadata, partial index options, conditional raw SQL, missing `up()` methods, and unsupported builder shapes.
- TypeORM extraction now emits clearer warnings for dynamic SQL and unsupported call shapes.
- File guards now catch binary-looking files and oversized inputs before analysis proceeds as if the file had no statements.

### LSP And Editor

- LSP configuration refresh now resets cached config correctly.
- Added document symbols, folding ranges, inlay hints, statement grouping, hover improvements, and stronger code-action coverage.
- Server cache behavior and fixture-based LSP behavior now have dedicated tests.
- The package surface test verifies the documented LSP export path.

### Output Formats

- GitLab Code Quality output is now shipped with extraction warnings and a coverage summary entry.
- SARIF output carries coverage metadata and treats unanalyzable extraction warnings as visible warnings.
- GitHub PR markdown includes clearer coverage output and avoids implying safety when dynamic statements need manual review.

### Release Boundaries

- Package surface tests and public-boundary checks now protect the npm package from local-only paths and unpublished surfaces.
- `pnpm pack` parsing is more robust, and release checks verify package contents before publish.
- GitHub Actions now run on the current Node action runtime and the pinned pnpm version.

### Tests

- Added package-surface tests, security tests, LSP cache tests, document symbol tests, folding range tests, inlay hint tests, and broader analyzer and reporter coverage.
- Added fixtures for concurrent special operations in transactions, incomplete ORM foreign key metadata, partial Sequelize indexes, unclosed transactions, schema renames, wide lock windows, and tautological DML.

## 0.4.1 (2026-03-16)

### Trust Contract

- **Transpiler silent failures eliminated**: 18 early-return paths in Knex (6) and Sequelize (12) transpilers that silently dropped migration statements now emit `ExtractionWarning` with descriptive messages. Previously, a `knex.schema.dropTable()` with a dynamic argument would vanish from analysis entirely.
- **Plugin crashes surfaced in structured output**: plugin rule/policy errors now appear as `ExtractionWarning` entries in JSON, GitHub, and SARIF output (not just stderr). A crashing custom plugin no longer silently passes CI.
- **Coverage calculation fixed**: added `unanalyzable` flag to `ExtractionWarning` to distinguish truly unanalyzable statements (dynamic SQL, transpile failures) from informational warnings (builder API detection, conditional SQL advisories). Coverage percentage now accurately reflects what was and was not analyzed.

### Bug Fixes

- **Trace mode DB connection leak**: `traceClient` and `observerClient` are now closed in the `finally` block. Previously, if any error was thrown between connect and end, both connections leaked and the container could hang.
- **Policy ignore bleed**: `fileIgnoredRules` now only reads from the first statement's `ignoredRules` (file-level comments), not from every statement. A `pgfence-ignore` comment on a DDL statement in the middle of the file no longer suppresses file-level policy checks.
- **`lock-timeout-after-dangerous-statement` now suppressible**: consistent with all other policy violations, this rule can now be suppressed via `-- pgfence-ignore`.
- **Stale `adjustedRisk` in trace-merge**: mismatch results now explicitly clear `adjustedRisk` so downstream code uses the recalculated risk, not the stale DB-size-adjusted value from static analysis.
- **NaN guard on timeout CLI options**: `--max-lock-timeout` and `--max-statement-timeout` now throw a descriptive error on non-numeric values instead of silently disabling threshold checks.
- **Stats file error context**: malformed `--stats-file` now shows the file path and specific parse error.
- **package.json error context**: includes the actual error message and file path.

### LSP Fixes

- Format auto-detection failure now emits an `ExtractionWarning` instead of silently falling back to raw SQL
- Analysis crash now clears stale diagnostics (previously, old "safe" diagnostics would persist after a crash)
- Configuration fetch errors are now logged for non-capability errors (was a bare catch swallowing everything)

### Comment Accuracy

- Fixed 11 stale/inaccurate comments across rule files: REINDEX TABLE lock mode (SHARE, not ACCESS EXCLUSIVE), ATTACH PARTITION PG12+ behavior, ALTER TYPE ADD VALUE type-object lock clarification, DROP CONSTRAINT added to destructive header, policy.ts state machine description, analyze-text.ts temp-file comment, alter-column.ts text conversion accuracy, best-practices.ts varchar widening note, cloud-hooks.ts "open-source mode" clarification, add-column.ts non-constant default description, add-constraint.ts VALIDATE lock description
- `db-stats.ts`: descriptive connection error messages
- `transaction-state.ts`: accurate depth tracking JSDoc
- `diagnostics.ts`: UTF-8 multi-byte character note
- `alter-column.ts`: accurate `classifyTypeChange` JSDoc

### Tests

- 393 tests (was 371 in 0.4.0)
- 10 new SARIF reporter tests (was zero coverage)
- DROP SCHEMA, DROP SCHEMA CASCADE, DROP CONSTRAINT tests with fixtures
- 6 `adjustRisk` boundary condition tests (exact thresholds: 9,999 vs 10,000, etc.)
- REFRESH MATERIALIZED VIEW WITH NO DATA test
- 2 coverage calculation tests verifying informational warnings do not deflate coverage

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
