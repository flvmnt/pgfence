# Changelog

## 0.8.0 (2026-09-16)

### Breaking

- **pgfence now runs when launched through a symlinked bin.** Since 0.5.0 the CLI exited 0 with no output and no analysis whenever it was started through a path containing a symlink: `node_modules/.bin/pgfence` under npm and yarn, `npx @flvmnt/pgfence` (including the official `flvmnt/pgfence` GitHub Action), a global `npm install -g` bin, a Windows directory junction, and pnpm's `node_modules/@flvmnt/pgfence` package symlink. Pointing `node` at a directory rather than a file, as in `node ./node_modules/@flvmnt/pgfence` or `node ./node_modules/@flvmnt/pgfence/dist`, failed the same way with no symlink involved at all, on every runtime without `import.meta.main`. Because `--ci` communicates through the exit code, those migration gates were green while zero files were analyzed. They now analyze. **Expect previously passing pipelines to fail, and expect the first failure to be large:** you are seeing your accumulated backlog, not a new false positive. To see the full picture without blocking, run once with `--max-risk critical --no-lock-timeout --no-statement-timeout`, then ratchet down. `--max-risk critical` alone is not enough: a missing `SET lock_timeout` is an error-severity policy violation, and those fail a `--ci` run regardless of `--max-risk`. Reported by [@CarbonDude](https://github.com/CarbonDude) in [#2](https://github.com/flvmnt/pgfence/issues/2), with a correct root-cause diagnosis.
- **`analyze` and `trace` now exit 2 when a run analyzes zero SQL statements.** Previously an empty file, a comment-only file, or an ORM migration whose `up()` contained no recognized query call printed `[SAFE]`, `No dangerous statements detected.` and `Coverage: 100%`, then exited 0. Zero of zero statements is not 100% coverage and it is not a pass. This fires only when the entire run produced no statements, analyzed or unanalyzable; a single empty placeholder among real migrations is reported per file and does not change the exit code. It does change the two artifacts that gate on content rather than on the exit code: that placeholder adds an `error`-level `pgfence-no-statements` result to SARIF and a `major`-severity row to GitLab Code Quality, so a pipeline gating on the uploaded artifact can go red while `pgfence` itself exits 0. One shape has no middle ground: a per-file loop such as `git diff --name-only | xargs -n1 pgfence analyze --ci` makes every single comment-only file its own whole run, so a comment-only revert fails that job with no opt-out. There is no opt-out flag: if a migration is intentionally a no-op, write it as one (`-- no-op: reverts <migration>` plus `SELECT 1;`) so it stays inside coverage. Exit 2 means pgfence could not do its job, so raising `--max-risk` will not help.
- **JSON report envelope is now `version: "1.1"`.** `coverage.coveragePercent` is `null` instead of `100` when no statements were found, and two fields are added: `coverage.analyzedNothing` (boolean) and `coverage.filesWithNoStatements` (array of paths). Machine consumers should gate on `coverage.analyzedNothing`.

### New surfaces

- **Anonymous telemetry**: pgfence now sends an anonymous usage count so we can tell how many people actually use it, which npm download numbers cannot answer. An event is 25 fields, every one a number, a boolean, or a value from a closed list: a random install id, the command, the pgfence/Node/OS versions, whether the run was in CI, how long it took, and counts of findings by severity. No SQL, file names, paths, table names, column names, rule ids, repository names, hostnames, usernames, environment variable values, database URLs or IP addresses are ever sent. The first run on a machine prints a notice to stderr and sends nothing at all, interactive runs queue locally and are delivered by a later run, CI runs send once inline within a 250ms budget and write no files, and the language server emits nothing ever. Full field list, real sample payloads, and the honest limits of the numbers are in [docs/telemetry.md](docs/telemetry.md).
- **`pgfence telemetry <status|enable|disable|reset>`**: inspect and change the setting from the CLI. `status` prints the install id, the state file path, how many events are queued, and the endpoint. `reset` deletes the install id and anything queued.

### Opt-outs

- **`PGFENCE_TELEMETRY=0`**: also accepts `false`, `off` and `no`, case insensitive. Any unrecognized value disables too, so a typo fails closed.
- **`DO_NOT_TRACK=1`**: the cross-vendor convention is honored for any value except empty, `0` and `false`.
- **`telemetry = false`**: new `.pgfence.toml` and `.pgfence.json` key, committed with the repo so it applies to everyone on the team. Unlike every other config key, it is read from the directory you run pgfence in and from every parent up to the repository root, so a key committed once at the root of a monorepo still applies to a developer or a CI step running from `packages/api`.
- **`pgfence telemetry disable`**: persisted per machine, and it also deletes anything already queued.
- Telemetry disables itself automatically under `NODE_ENV=test` and `VITEST`. `PGFENCE_TELEMETRY_DEBUG=1` prints the exact payload to stderr and sends nothing, so every claim in the docs can be verified in one command.

### Output formats

- **`detectedFormat`**: `--output json` now reports which migration format produced each result (`sql`, `typeorm`, `prisma`, `knex`, `drizzle`, `sequelize`, `kysely`) after `auto` detection resolved it. Additive and backward compatible. SARIF, GitLab and GitHub output are unchanged. This is the one part of the release that is not gated on the telemetry setting: it is a property of the analysis result, so it is emitted whether telemetry is on or off. A consumer validating pgfence's JSON with a strict `additionalProperties: false` schema needs to allow it.

### Trust Contract

- Fixed the entry-point guard in `dist/index.js` and `dist/lsp/server.js`. Both compared `path.resolve(process.argv[1])`, which is purely lexical, against `import.meta.url`, which Node has already realpath-resolved. Both sides are now canonicalized with the same function, so symlinked files, symlinked parent directories, Windows junctions and case-differing paths all compare correctly, with `import.meta.main` used as a fast path where the runtime provides it. When `argv[1]` is a directory, which no comparison of two paths can reconcile with a file, the guard redoes the `package.json` `main` and `index.js` resolution Node itself did and compares the result. Every branch either leaves the previous answer alone or turns a `false` into a `true`, so no launcher that worked in 0.7.0 can stop working in 0.8.0.
- Added a contradiction check: if pgfence is launched under the name `pgfence` or `pgfence-lsp` but cannot confirm it is the entry module, it now writes a diagnostic naming `argv[1]`, `import.meta.url`, platform and runtime, and exits 2. A safety linter must never exit 0 in silence. Two limits worth knowing, because the check reads `argv[1]`'s basename and nothing else. It does not cover Windows, where the `.cmd` shim makes that basename `index`; that is the path that already worked and the one that masked the original bug. And it fires on any process whose own entry file is named `pgfence` or `pgfence-lsp` and that imports this package for side effects, which would exit 2 before the host's first statement. The root export is `export {}`, so nothing has a reason to import it, but if you wrap pgfence in a script of that name, invoke the bin rather than importing the module.
- **`pgfence-lsp` now starts when launched through a symlink.** The LSP server carried the identical guard defect, so under pnpm and through `node_modules/.bin/pgfence-lsp` it exited immediately with nothing on stdout or stderr. Editors showed a server that started and died with no error, which read as "no problems found". VS Code users on pnpm will start seeing diagnostics on files they have had open for months.
- Coverage summaries no longer claim `Coverage: 100%` for a run that analyzed nothing. `coveragePercent` is now `null` rather than `100` when there were zero statements, so the CLI, GitHub and GitLab reporters render `Coverage: n/a (no SQL statements found)` and the JSON and SARIF reporters carry a literal `null` for machine consumers to test.
- The TypeORM, Knex and Kysely extractors now emit an `ExtractionWarning` when a migration's `up()` yields zero recognized query calls, matching the guard Sequelize already had. A migration that routed its SQL through a shared helper previously reported `[SAFE]` at `Coverage: 100%`; it now reports `[UNANALYZABLE]` at `Coverage: 0%`, and `--unknown block` fails it. The condition is "no query call was recognized", not "no SQL was extracted": a migration whose only `query()` call is dynamic already warns on that line and is not warned about twice, so no dynamic-SQL count changes. This also reaches the editor, where the language server runs the same extractors: a freshly generated ORM migration carries the warning at line 1 until its first query call is written, and under `pgfence.unknown: "block"` that warning is an error.

### CLI And Boundaries

- Files with zero statements now render as `[NO STATEMENTS]` in the CLI reporter and `:grey_question: NO STATEMENTS` in the GitHub reporter, distinct from `[UNANALYZABLE]`, which means SQL was found but could not be read.
- SARIF now emits a `pgfence-no-statements` result at level `error` for each unchecked file, and GitLab Code Quality emits a `pgfence-no-statements` row at `major` severity and raises the coverage summary row from `info` to `major` when nothing was analyzed. Both previously stayed below any realistic failure threshold.
- `analyze --ci` now sets the exit code and returns instead of calling `process.exit` immediately after writing the report. On macOS a piped stdout is asynchronous, so the old form truncated a report larger than the 64KB pipe buffer, which is reachable with `--output sarif > pgfence.sarif` over a large migration set. The exit code is unchanged.
- A run that analyzes nothing is recorded in telemetry as an errored run rather than a clean one, so an always-on gate that starts firing in the field is visible in the numbers instead of looking like a healthy analyze. The event's fields are unchanged.
- Added `src/entry-point.ts`, a private helper shared by both bin targets. It is deliberately not added to `package.json` exports.

## 0.7.0 (2026-09-05)

### New surfaces

- **`pgfence analyze --fix`**: auto-fixes a small, explicit allowlist of safe single-statement findings in place: adds `CONCURRENTLY` (and `IF NOT EXISTS` where safe) to `CREATE`/`DROP INDEX`, and prepends missing `lock_timeout`/`statement_timeout`/`idle_in_transaction_session_timeout` `SET` statements. Only rewrites files that resolve to the raw `sql` format; everything else is reported, never guessed. Refuses to fix a statement sitting inside an explicit transaction block, since `CONCURRENTLY` cannot run there. Combined with `--ci`, fixed files are re-analyzed from disk before CI gating, so `--ci` can never pass on stale pre-fix findings.
- **`pgfence analyze --fix --split`**: scaffolds new sibling migration files for the multi-step expand/backfill/contract recipes (`ADD COLUMN NOT NULL`, `ADD FOREIGN KEY`, `ADD UNIQUE`) instead of leaving them manual. Never edits the original file. The generated backfill file is always an inert, fully-commented-out template that states plainly it needs manual scheduling.
- **Kysely extractor** (`--format kysely`, also auto-detected): extracts literal `sql\`...\`.execute()` statements and transpiles the common `createTable`/`alterTable`/`createIndex`/`dropIndex` schema-builder subset into SQL for analysis. Unsupported builder calls fail closed with an `ExtractionWarning` instead of being silently dropped.

### Trust Contract

- Fixed a `CREATE INDEX` safe-rewrite bug where an unnamed index could get `IF NOT EXISTS` inserted into invalid syntax.
- Fixed `DROP INDEX`'s safe rewrite reconstructing the target name from parsed AST fields, which silently dropped schema qualification and quoting on anything but a plain lowercase identifier; it now preserves the original text exactly.
- Added `DROP INDEX` -> owning table resolution via the schema snapshot, so size-aware risk scoring can see drops on indexes belonging to large tables.

## 0.6.1 (2026-06-02)

### Trust Contract

- Fixed false negatives in TypeORM manager alias extraction and Knex schema alias extraction.
- Fixed coverage accounting so procedural statements that are intentionally skipped do not inflate analyzed statement counts.
- Fixed size-aware foreign key risk scoring so referenced table stats are considered with the child table.
- Fixed ADD COLUMN identity and same-file constrained domain analysis so high-risk additions are reported.
- Fixed timeout ordering analysis for row security and policy operations that take ACCESS EXCLUSIVE locks.
- Fixed GitLab coverage summaries so dynamic SQL points to the real source line.

### CLI And Boundaries

- Fixed CLI precedence so `--db-url` overrides `--stats-file`.
- Hardened public boundary checks for bare imports into excluded implementation areas.
- Fixed LSP fallback analysis for mixed parseable and unparseable statements.
- Fixed trace-mode parsing so one malformed extracted ORM statement does not discard valid traced statements from the same file.
- Added fail-closed Sequelize handling for computed `createTable` column keys.
- Fixed destructured TypeORM manager aliases and Knex schema aliases so SQL does not disappear from coverage.
- Fixed inline foreign key risk scoring so referenced table stats participate in size-aware escalation.
- Fixed late `lock_timeout` ordering for rule-emitted ACCESS EXCLUSIVE checks such as CLUSTER, VACUUM FULL, inline foreign keys, and constrained-domain additions.
- Added schema snapshot domain metadata and unresolved custom-type caveats for ADD COLUMN.
- Fixed CLI stats-source precedence so explicit `--stats-file` can override a configured DB URL.
- Tightened lint boundary patterns for bare imports into excluded implementation areas.
- Fixed Knex auto-increment `.alter()` warnings so coverage points to an actionable source line.
- Generated Prisma workflow package pins now derive from package metadata.
- Clarified generated Prisma workflow and GitHub Actions examples for version 0.6.1.

## 0.6.0 (2026-05-25)

### New surfaces

- **`pgfence explain "<statement>"`**: paste-and-run single-statement explainer. Returns lock mode, blocked operations, risk level, and safe rewrite recipe for any DDL you paste in. Reads from positional arg or stdin. `--output json` for machine consumption.
- **`RULES.md`** at the repo root: a curated single-file rule catalog distilled from `src/rules/*` into ~250 readable lines. Drop it into your repo so your in-editor coding assistant learns pgfence conventions and suggests safe migrations from the first keystroke.
- **`pgfence init --prisma-github-action`**: scaffolds `.github/workflows/pgfence-prisma.yml` so projects on Prisma get a one-command CI integration.

### New rules: production footguns no other linter catches

Verified against the PostgreSQL source and explicit-locking.html:

- **`cluster`** HIGH, ACCESS EXCLUSIVE. CLUSTER rewrites the entire table. Recommends `pg_repack`.
- **`replica-identity-full`** HIGH. Catches the silent 10x to 100x WAL amplification that saturates Debezium / pglogical consumers. `DEFAULT` and `USING INDEX` are not flagged.
- **`enable-rls`** / **`disable-rls`** HIGH. Enabling RLS without a matching `CREATE POLICY` denies rows for affected non-owner roles. Disabling silently exposes rows that policies gated.
- **`force-rls`** / **`no-force-rls`** HIGH. Changes whether table owners are subject to row security policies.
- **`inherit`** / **`no-inherit`** HIGH. Catalog-bound inheritance changes under ACCESS EXCLUSIVE on both parent and child.
- **`create-policy`** MEDIUM. Calls out the brief ACCESS EXCLUSIVE catalog change and that the policy is inert until ROW LEVEL SECURITY is enabled on the table.
- **`create-enum-type`** LOW. Postgres has no `ALTER TYPE ... DROP VALUE`. Suggests a lookup table or `CHECK` constraint for evolving categorical data.

Eugene, Squawk, pgrubic, and strong_migrations together cover none of REPLICA IDENTITY FULL, RLS toggle, CLUSTER, or INHERIT.

### Trust Contract polish

- Coverage line across all five reporters (CLI, JSON, GitHub PR, GitLab, trace CLI) now includes a `(lines A, B, ...)` suffix that identifies WHERE the unanalyzable statements live. The JSON envelope exposes `coverage.dynamicStatementLines` for machine consumers. Trace CLI now also emits the Unanalyzable count (previously only Verified / Mismatches / Trace-only).
- LSP now respects `unknownHandling=block` in editor diagnostics: unanalyzable statements surface as Error severity in block mode, matching the CLI block-mode exit code.

### Lock mode correctness

- `ALTER COLUMN DROP NOT NULL`: bumped from LOW to MEDIUM. The operation is metadata-only and instant on PG9+, but the brief ACCESS EXCLUSIVE lock still risks lock-queue stalls under any concurrent long-running transaction.

### Dependencies

- `libpg-query` 16.7.3 to 17.7.3 (PG17 grammar parity; all 534 tests still green).
- `commander` 13.1.0 to 14.0.3.
- Patch sweep for prettier, tsx, @types/pg, pg, typescript-eslint, @typescript-eslint/typescript-estree.
- Local `PgClient.connect()` now typed as `Promise<unknown>` so pg 8.20+'s `connect() => Promise<Client>` is assignable without casts.

### Packaging

- Tarball drops from 173 KB to 110 KB (-36%) by excluding `dist/**/*.map`.
- Added `homepage`, `bugs`, and `repository` fields to package.json for npm SEO.

### Fixes

- `examples/try-this/README.md`: replaced em dashes with colons to satisfy repo copy rules.
- `tests/cli.test.ts`: `wouldCiFail` helper now mirrors production `shouldFailCI`, including the `unknownHandling=block` branch. Previously a regression in that branch would have passed CI.
- `tests/cli.test.ts`: `--stats-file` test now writes to a tmpdir instead of the project CWD (parallel-safe).
- `src/index.ts`: clear trace pg clients after explicit `.end()` so the finally cleanup is a no-op (avoids `stderr` noise on slow network flush).

### Documentation

- Per-rule severity, lock mode, and safe rewrite pattern documented in `RULES.md`.
- README highlights `RULES.md` and `pgfence explain` under "Shipped Surfaces".

## 0.5.1 (2026-04-29)

### Fixes

- Replaced the VS Code Marketplace README badge with a stable Shields badge after the dynamic marketplace badge endpoint started returning a retired badge.
- Fixed `VACUUM (FULL false)` parsing so pgfence only reports `vacuum-full` when FULL is enabled.
- Added detection and tests for inline `CREATE TABLE ... EXCLUDE` constraints, marked as low risk because they apply to a new table.
- Updated the lock safety documentation matrix to include inline `CREATE TABLE ... EXCLUDE` constraints.

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

- Fixed 11 stale/inaccurate comments across rule files: REINDEX TABLE lock mode (SHARE, not ACCESS EXCLUSIVE), ATTACH PARTITION PG12+ behavior, ALTER TYPE ADD VALUE type-object lock clarification, DROP CONSTRAINT added to destructive header, policy.ts state machine description, analyze-text.ts temp-file comment, alter-column.ts text conversion accuracy, best-practices.ts varchar widening note, local-only hook comment clarification, add-column.ts non-constant default description, add-constraint.ts VALIDATE lock description
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

- Added ADD CONSTRAINT lock-mode coverage for foreign keys, primary keys, and pre-built index attachment.
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
