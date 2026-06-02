<table><tr>
  <td>
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/flvmnt/pgfence/main/.github/logo-dark.svg">
      <img src="https://raw.githubusercontent.com/flvmnt/pgfence/main/.github/logo.svg" width="120" alt="pgfence logo" />
    </picture>
  </td>
  <td>
    <h1>pgfence</h1>
    <p>Postgres migration safety CLI. Know your lock modes, risk levels, and safe rewrite recipes before you merge.</p>
    <p><strong>ORM-aware migration safety for TypeORM, Prisma, Knex, Drizzle, and Sequelize.</strong></p>
    <p>
      <a href="https://github.com/flvmnt/pgfence/actions/workflows/ci.yml"><img src="https://github.com/flvmnt/pgfence/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
      <a href="https://www.npmjs.com/package/@flvmnt/pgfence"><img src="https://img.shields.io/npm/v/@flvmnt/pgfence" alt="npm" /></a>
      <a href="https://www.npmjs.com/package/@flvmnt/pgfence"><img src="https://img.shields.io/npm/dw/@flvmnt/pgfence" alt="npm downloads" /></a>
      <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
      <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js" /></a>
      <a href="https://marketplace.visualstudio.com/items?itemName=flvmnt.pgfence"><img src="https://img.shields.io/badge/VS%20Code-Marketplace-007ACC?logo=visualstudiocode&logoColor=white" alt="VS Code Marketplace" /></a>
      <a href="https://pgfence.com"><img src="https://img.shields.io/badge/website-pgfence.com-blue" alt="Website" /></a>
    </p>
  </td>
</tr></table>

---

## The Problem

Your ORM migration just took down production for 47 seconds.

A seemingly innocent `ALTER TABLE users ADD COLUMN last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()` grabbed an `ACCESS EXCLUSIVE` lock on your 12M-row users table. Every query queued behind it. Your healthchecks failed. Pods restarted. Customers noticed.

This happens because ORMs hide the Postgres lock semantics from you. You can't fix what you can't see.

## What pgfence Does

pgfence analyzes your SQL migration files **before they hit production** and tells you:

1. **What lock mode** each DDL statement acquires and **what it blocks** (reads, writes, or both)
2. **Risk level** for each operation, optionally adjusted by actual table size from your database
3. **Safe rewrite recipes**, the exact expand/contract sequence to run instead

Works with **raw SQL**, **TypeORM**, **Prisma**, **Knex**, **Drizzle**, and **Sequelize** migrations. No Ruby, no Rust, no Go. Just TypeScript.

## Shipped Surfaces

- Prisma support is real, not aspirational, with a dedicated extractor and tests in the repo.
- TypeORM, Knex, Drizzle, and Sequelize support are also shipped with dedicated extractors and extractor coverage in the repo.
- GitLab Code Quality output is shipped in the repo, with reporter tests covering repeated findings, extraction warnings, and coverage visibility.
- The public changelog records major shipped surfaces such as GitHub PR comments, SARIF, LSP, and trace mode.
- The tracked rule-family reference lives in [checks-overview.md](checks-overview.md), and the concrete risky-migration walkthrough lives in [examples/pr-review-demo](examples/pr-review-demo/README.md).
- [RULES.md](RULES.md) is a curated single-file rule catalog. Drop it into your repo so your in-editor coding assistant learns pgfence conventions and suggests safe migrations from the first keystroke.
- `pgfence explain "<statement>"` returns the lock mode, what it blocks, and the safe rewrite for a single SQL statement (handy in Slack/Discord threads).

## External Mentions

- Prisma documents pgfence as a pre-deploy migration safety check before `prisma migrate deploy`: [Prisma deployment docs](https://www.prisma.io/docs/orm/prisma-client/deployment/deploy-database-changes-with-prisma-migrate#pre-deploy-migration-safety-checks).
- Prisma also maintains a dedicated pgfence setup page: [Prisma integration guide](https://www.prisma.io/docs/guides/integrations/pgfence).
- pgfence is listed in the public [pglt Related Work](https://github.com/supabase-community/postgres-language-server/blob/main/docs/reference/related_work.md) page.

## Quick Demo

```
$ pgfence analyze migrations/add-email-verified.sql

pgfence - Migration Safety Report

┌─────────────────────────────────────────────────┬──────────────────┬──────────┬────────┐
│ Statement                                       │ Lock Mode        │ Blocks   │ Risk   │
├─────────────────────────────────────────────────┼──────────────────┼──────────┼────────┤
│ ALTER TABLE users ADD COLUMN last_seen_at       │ ACCESS EXCLUSIVE │ R + W    │ HIGH   │
│ TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()  │                  │          │        │
├─────────────────────────────────────────────────┼──────────────────┼──────────┼────────┤
│ CREATE INDEX idx_users_email ON users(email)    │ SHARE            │ W        │ MEDIUM │
└─────────────────────────────────────────────────┴──────────────────┴──────────┴────────┘

Policy Violations:
  ✗ Missing SET lock_timeout: add SET lock_timeout = '2s' at the start

Safe Rewrites:
  1. ADD COLUMN with NOT NULL + volatile DEFAULT → split into expand/backfill/contract:
     • ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
     • Backfill in batches: WITH batch AS (SELECT ctid FROM users WHERE email_verified IS NULL LIMIT 1000 FOR UPDATE SKIP LOCKED) UPDATE users t SET email_verified = <fill_value> FROM batch WHERE t.ctid = batch.ctid;
     • ALTER TABLE users ADD CONSTRAINT ... CHECK (email_verified IS NOT NULL) NOT VALID;
     • ALTER TABLE users VALIDATE CONSTRAINT ...;

  2. CREATE INDEX → use CONCURRENTLY:
     • CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email ON users(email);

=== Coverage ===
Analyzed 2 SQL statements. 0 dynamic statements not analyzable. Coverage: 100%
```

## Try pgfence in 30 seconds

Clone the repo and run pgfence on a real-feeling migration that hides four production-grade footguns:

```bash
git clone https://github.com/flvmnt/pgfence.git
cd pgfence
npx @flvmnt/pgfence analyze examples/try-this/dangerous-migration.sql
```

You will see eight findings on three statements: lock modes, risk levels, the safe rewrite for each one, and four policy violations. See [`examples/try-this/`](examples/try-this/README.md) for the walkthrough.

Want to try it on your own migrations?

```bash
npm install -g @flvmnt/pgfence
pgfence analyze path/to/your/migrations/*.sql
```

If pgfence missed something dangerous, or flagged something safe, [open an issue](https://github.com/flvmnt/pgfence/issues/new/choose) with the SQL. Templates exist for false negatives, false positives, and unsupported ORM patterns. Every dangerous-migration pattern in the rules table below started as someone's incident, and we want yours.

## Postgres Version Support

pgfence defaults to **PostgreSQL 14+** assumptions, and several rules are version-aware for older and newer releases where PostgreSQL behavior differs. Use `--min-pg-version` to override if needed:

```bash
pgfence analyze --min-pg-version 12 migrations/*.sql
```

Version-sensitive behavior:
- `ADD COLUMN ... DEFAULT <constant>` is instant (metadata-only) on PG 11+
- `ALTER TYPE ADD VALUE` is instant on PG 12+
- `REINDEX CONCURRENTLY` available on PG 12+
- `RENAME COLUMN` is instant on PG 14+
- `DETACH PARTITION CONCURRENTLY` available on PG 14+

## Known Limitations

pgfence performs static analysis. The following are not supported:

- **Dynamic SQL**: template literals, string concatenation, runtime-computed table or column names
- **PL/pgSQL and stored procedures**: DDL inside `DO $$ ... $$` blocks is not analyzed
- **DDL inside functions**: `CREATE FUNCTION` bodies are not parsed for migration safety
- **Non-migration SQL**: arbitrary application queries, not just DDL

When dynamic SQL is detected, pgfence surfaces warnings on the supported extractor paths. Some ORM builder chains can still only be partially reconstructed, so treat the coverage line as a lower bound on what was analyzed.

To explicitly acknowledge a statement pgfence cannot analyze, add `-- pgfence-ignore` before it, see [Suppressing warnings](#suppressing-warnings).

## Alternatives

Other tools in this space worth knowing about:

| Tool | Language | Best fit | Focus |
|------|----------|----------|-------|
| [Squawk](https://github.com/sbdchd/squawk) | Rust | Raw SQL teams | SQL linting and SQL authoring tooling |
| [Eugene](https://github.com/kaaveland/eugene) | Rust | Raw SQL teams that want trace-style verification | DDL linting and trace-based verification |
| [strong_migrations](https://github.com/ankane/strong_migrations) | Ruby | Rails / ActiveRecord teams | Runtime migration safety checks |
| [pgroll](https://github.com/xataio/pgroll) | Go | Teams that need a migration executor | Migration **execution** with rollback support |
| **pgfence** | **TypeScript** | **Node.js and TypeScript teams using SQL or ORMs** | **Multi-ORM migration safety, risk scoring, and safe rewrite guidance** |

pgfence analyzes ORM migration files (TypeORM, Prisma, Knex, Drizzle, Sequelize) directly, which is the wedge over SQL-only linters. It also provides DB-size-aware risk scoring and safe rewrite guidance for common migration patterns.

pgroll is not a competitor: it is a runtime executor (runs migrations with automatic rollback). pgfence analyzes before you run; pgroll handles how you run. They are complementary.

## VS Code Extension

Get real-time migration safety analysis directly in your editor:

- **Inline diagnostics**: lock modes, risk levels, and policy violations as you type
- **Quick fixes**: one-click fixes for supported safe rewrites
- **Hover info**: lock mode, blocked operations, and safe alternatives

**[Install from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=flvmnt.pgfence)** or search "pgfence" in the Extensions panel. Requires `@flvmnt/pgfence` installed in your project or globally. See the [extension docs](https://pgfence.com/docs/editor) for configuration and commands.

If you want to launch the standalone language server directly, use the `pgfence-lsp` binary.

## Installation

```bash
npm install -g @flvmnt/pgfence
```

Or with pnpm:

```bash
pnpm add -g @flvmnt/pgfence
```

## Usage

### Install pre-commit or pre-push hook

Prevent footguns locally before committing or pushing by installing a git hook.

To install a **pre-commit** hook:
```bash
pgfence init
```
*(Automatically detects `.husky/` or `.git/hooks/` and creates a pre-commit hook.)*

If you prefer to run checks only when pushing to remote, simply rename the generated file:
```bash
# Standard Git
mv .git/hooks/pre-commit .git/hooks/pre-push

# Husky
mv .husky/pre-commit .husky/pre-push
```

### Add Prisma migration safety to GitHub Actions

For Prisma projects, generate a ready workflow that runs pgfence before production migrations are deployed:

```bash
pgfence init --prisma-github-action
```

This writes `.github/workflows/pgfence-prisma.yml`. The workflow runs on pull requests that touch `prisma/migrations/**/migration.sql`, finds every Prisma `migration.sql` file, and checks them with:

```bash
npx --yes @flvmnt/pgfence@0.6.1 analyze --format prisma --ci --max-risk medium
```

The command refuses to overwrite an existing `pgfence-prisma.yml`, so you can review or rename your current workflow first.

### Analyze SQL migrations

```bash
pgfence analyze migrations/*.sql
```

### Analyze TypeORM migrations

```bash
pgfence analyze --format typeorm src/migrations/*.ts
```

### Analyze Prisma migrations

```bash
pgfence analyze --format prisma prisma/migrations/**/migration.sql
```

### Analyze Knex migrations

```bash
pgfence analyze --format knex migrations/*.ts
```

### Auto-detect format

```bash
pgfence analyze migrations/*  # detects format from file content
```

### DB-size-aware risk scoring

You can provide table stats in two ways:

- **Live connection**: pgfence connects to your database and queries `pg_stat_user_tables`:

```bash
pgfence analyze --db-url postgres://readonly@replica:5432/mydb migrations/*.sql
```

- **Stats snapshot file**: use a pre-generated JSON file (e.g. from your CI) so pgfence never needs DB credentials:

```bash
pgfence analyze --stats-file pgfence-stats.json migrations/*.sql
```

If both `--db-url` and `--stats-file` are provided, `--db-url` is used and the stats file is ignored.

When stats are available (from either source), pgfence adjusts risk levels as follows:

| Table Size | Risk Adjustment |
|-----------|----------------|
| < 10K rows | No change |
| 10K - 1M rows | +1 level |
| 1M - 10M rows | +2 levels |
| > 10M rows | CRITICAL |

### Output formats

```bash
# Terminal table (default)
pgfence analyze migrations/*.sql

# Machine-readable JSON
pgfence analyze --output json migrations/*.sql

# GitHub PR comment markdown
pgfence analyze --output github migrations/*.sql
```

### CI mode

```bash
# Exit 1 when risk exceeds MEDIUM, a policy error is present, or --unknown block sees unanalyzable SQL
pgfence analyze --ci --max-risk medium migrations/*.sql
```

### Suppressing warnings

Add an inline comment immediately before a statement to suppress checks for it:

```sql
-- pgfence-ignore
DROP TABLE old_sessions;  -- all checks suppressed for this statement

-- pgfence-ignore: drop-table
DROP TABLE old_logs;  -- only the drop-table check suppressed; others still fire

-- pgfence-ignore: drop-table, prefer-robust-drop-table
DROP TABLE old_queue;  -- multiple rules suppressed, comma-separated
```

The directive applies to the single statement immediately following the comment.

| Syntax | Effect |
|--------|--------|
| `-- pgfence-ignore` | Suppress all checks for the next statement |
| `-- pgfence-ignore: <ruleId>` | Suppress one specific rule |
| `-- pgfence-ignore: <ruleId>, <ruleId>` | Suppress multiple specific rules |
| `-- pgfence: ignore <ruleId>` | Legacy syntax, still supported |

Use `--output json` to see `ruleId` values for any check you want to suppress.

## What It Catches

pgfence checks a broad set of DDL patterns against Postgres's lock mode semantics:

### Lock & Safety Checks

| # | Pattern | Lock Mode | Risk | Safe Alternative |
|---|---------|-----------|------|------------------|
| 1 | `ADD COLUMN ... NOT NULL` (no DEFAULT) | ACCESS EXCLUSIVE | HIGH | Add nullable, backfill, SET NOT NULL |
| 2 | `ADD COLUMN ... DEFAULT <volatile>` | ACCESS EXCLUSIVE | HIGH | Add without default, backfill in batches |
| 3 | `ADD COLUMN ... DEFAULT <constant>` | ACCESS EXCLUSIVE (instant) | LOW | Safe on PG11+ (metadata-only) |
| 4 | `ADD COLUMN ... GENERATED STORED` | ACCESS EXCLUSIVE | HIGH | Add regular column + trigger + backfill |
| 5 | `CREATE INDEX` (non-concurrent) | SHARE | MEDIUM | `CREATE INDEX CONCURRENTLY` |
| 6 | `DROP INDEX` (non-concurrent) | ACCESS EXCLUSIVE | MEDIUM | `DROP INDEX CONCURRENTLY` |
| 7 | `ALTER COLUMN TYPE` (text/varchar widening, schema verified) | ACCESS EXCLUSIVE | LOW | Metadata-only, no table rewrite |
| | `ALTER COLUMN TYPE varchar(N)` (schema unknown) | ACCESS EXCLUSIVE | HIGH | Provide a schema snapshot to prove widening |
| | `ALTER COLUMN TYPE` (cross-family) | ACCESS EXCLUSIVE | HIGH | Expand/contract pattern |
| 8 | `ALTER COLUMN SET NOT NULL` | ACCESS EXCLUSIVE | MEDIUM | CHECK constraint NOT VALID + validate |
| 9 | `ADD CONSTRAINT ... FOREIGN KEY` | SHARE ROW EXCLUSIVE | HIGH | NOT VALID + VALIDATE CONSTRAINT |
| 10 | `ADD CONSTRAINT ... CHECK` | ACCESS EXCLUSIVE | MEDIUM | NOT VALID + VALIDATE CONSTRAINT |
| 11 | `ADD CONSTRAINT ... UNIQUE` | ACCESS EXCLUSIVE | HIGH | CONCURRENTLY unique index + USING INDEX |
| | `ADD CONSTRAINT ... UNIQUE USING INDEX` | ACCESS EXCLUSIVE | LOW | Brief metadata operation, attaches pre-built index |
| 12 | `ADD CONSTRAINT ... EXCLUDE` | ACCESS EXCLUSIVE | HIGH | No concurrent alternative; use lock_timeout |
| | `CREATE TABLE ... EXCLUDE` | SHARE ROW EXCLUSIVE | LOW | New table only; safe to review as table creation |
| 13 | `DROP TABLE` | ACCESS EXCLUSIVE | CRITICAL | Separate release |
| 14 | `DROP COLUMN` | ACCESS EXCLUSIVE | HIGH | Remove app references first, then drop |
| 15 | `TRUNCATE` | ACCESS EXCLUSIVE | CRITICAL | Batched DELETE |
| 16 | `TRUNCATE ... CASCADE` | ACCESS EXCLUSIVE | CRITICAL | Explicit per-table truncate or batched DELETE |
| 17 | `RENAME COLUMN` | ACCESS EXCLUSIVE | LOW | Instant on PG14+ |
| 18 | `RENAME TABLE` | ACCESS EXCLUSIVE | HIGH | Rename + create view for backwards compat |
| 19 | `VACUUM FULL` | ACCESS EXCLUSIVE | HIGH | Use pg_repack |
| 20 | `ALTER TYPE ... ADD VALUE` (PG < 12) | ACCESS EXCLUSIVE | MEDIUM | Upgrade to PG12+ for instant enum adds |
| | `ALTER TYPE ... ADD VALUE` (PG12+) | EXCLUSIVE (instant) | LOW | Safe; cannot run inside transaction |
| 21 | `ATTACH PARTITION` (PG < 12) | ACCESS EXCLUSIVE | HIGH | Create matching CHECK constraint first |
| | `ATTACH PARTITION` (PG12+) | SHARE UPDATE EXCLUSIVE on parent, ACCESS EXCLUSIVE on partition | HIGH | CHECK constraint helps skip validation scan |
| 22 | `DETACH PARTITION` (non-concurrent) | ACCESS EXCLUSIVE | HIGH | `DETACH PARTITION CONCURRENTLY` (PG14+) |
| 23 | `REFRESH MATERIALIZED VIEW` | ACCESS EXCLUSIVE | HIGH | `REFRESH MATERIALIZED VIEW CONCURRENTLY` |
| | `REFRESH MATERIALIZED VIEW CONCURRENTLY` | EXCLUSIVE | LOW | Blocks writes and DDL; requires unique index |
| 24a | `REINDEX TABLE` (non-concurrent) | SHARE | HIGH | `REINDEX TABLE CONCURRENTLY` (PG12+) |
| 24b | `REINDEX INDEX` (non-concurrent) | ACCESS EXCLUSIVE | HIGH | `REINDEX INDEX CONCURRENTLY` (PG12+) |
| 24c | `REINDEX SCHEMA/DATABASE` (non-concurrent) | ACCESS EXCLUSIVE | CRITICAL | `REINDEX CONCURRENTLY` (PG12+) |
| 25 | `CREATE TRIGGER` | SHARE ROW EXCLUSIVE | MEDIUM | Use `lock_timeout` to bound lock wait |
| 26 | `DROP TRIGGER` | ACCESS EXCLUSIVE | MEDIUM | Use `lock_timeout` to bound lock wait |
| 27 | `ENABLE/DISABLE TRIGGER` | SHARE ROW EXCLUSIVE | LOW | Blocks concurrent DDL only |
| 28 | `SET LOGGED/UNLOGGED` | ACCESS EXCLUSIVE | HIGH | Full table rewrite; no non-blocking alternative |

### Data Type Best Practices

| # | Pattern | Risk | Suggestion |
|---|---------|------|------------|
| 29 | `ADD COLUMN ... json` | LOW | Use `jsonb`, json has no equality operator |
| 30 | `ADD COLUMN ... serial` | MEDIUM | Use `GENERATED ALWAYS AS IDENTITY` |
| 31 | `integer` / `int` columns | LOW | Use `bigint` to avoid future overflow + rewrite |
| 32 | `varchar(N)` columns | LOW | Use `text`, changing varchar length requires ACCESS EXCLUSIVE |
| 33 | `timestamp` without time zone | LOW | Use `timestamptz` to avoid timezone bugs |
| 34 | `char(N)` / `character(N)` columns | LOW | Use `text`, char pads with spaces and length changes require rewrite |
| 35 | `serial` / `bigserial` / `smallserial` | LOW | Use `IDENTITY` columns, cleaner semantics |

### Destructive & Domain Checks

| # | Pattern | Lock Mode | Risk | Safe Alternative |
|---|---------|-----------|------|------------------|
| 36 | `DROP DATABASE` | ACCESS EXCLUSIVE | CRITICAL | Irreversible, requires separate process |
| 37 | `ALTER DOMAIN ADD CONSTRAINT` | SHARE | HIGH | Validates against all tables using domain |
| 38 | `CREATE DOMAIN` with constraint | ACCESS SHARE | LOW | Use table-level CHECK constraints instead |

### Production footguns no other linter catches today

These ship in v0.6 and are not flagged by Eugene, Squawk, pgrubic, or strong_migrations:

| # | Pattern | Lock Mode | Risk | Safe Alternative |
|---|---------|-----------|------|------------------|
| 43 | `CLUSTER table USING idx` | ACCESS EXCLUSIVE | HIGH | Use `pg_repack` for online reclustering |
| 44 | `REPLICA IDENTITY FULL` | ACCESS EXCLUSIVE (brief) | HIGH | Use primary key (default) or unique non-null index; FULL amplifies WAL 10x-100x |
| 45 | `ENABLE ROW LEVEL SECURITY` | ACCESS EXCLUSIVE | HIGH | Create policies BEFORE enabling RLS or affected non-owner roles lose access |
| 46 | `DISABLE ROW LEVEL SECURITY` | ACCESS EXCLUSIVE | HIGH | Audit which rows were gated by policies before disabling |
| 47 | `ALTER TABLE ... INHERIT/NO INHERIT` | ACCESS EXCLUSIVE (both tables) | HIGH | Catalog-bound change; schedule in maintenance window with lock_timeout |
| 48 | `CREATE POLICY` | ACCESS EXCLUSIVE (brief) | MEDIUM | Inert until RLS is enabled; verify ordering with `ALTER TABLE ENABLE ROW LEVEL SECURITY` |
| 49 | `CREATE TYPE ... AS ENUM` | n/a | LOW | Postgres has no `ALTER TYPE ... DROP VALUE`; prefer lookup table or CHECK constraint for evolving sets |

### Transaction & Policy Checks

| # | Pattern | Severity |
|---|---------|----------|
| 39 | NOT VALID + VALIDATE CONSTRAINT in same transaction | error |
| 40 | Multiple ACCESS EXCLUSIVE statements compounding | warning |
| 41 | `CREATE INDEX CONCURRENTLY` inside transaction | error |
| 42 | Bulk `UPDATE` without `WHERE` in migration | warning |

## Policy Checks

Beyond DDL analysis, pgfence enforces operational best practices:

- **Missing `SET lock_timeout`**: prevents lock queue death spirals
- **Missing `SET statement_timeout`**: aborts statements that run past the threshold instead of holding locks indefinitely
- **Missing `SET application_name`**: enables `pg_stat_activity` visibility
- **Missing `SET idle_in_transaction_session_timeout`**: prevents orphaned locks
- **`CREATE INDEX CONCURRENTLY` inside transaction**: will fail at runtime
- **NOT VALID + VALIDATE in same transaction**: defeats the purpose of NOT VALID
- **Multiple ACCESS EXCLUSIVE statements**: compounding lock duration
- **Bulk `UPDATE` without `WHERE`**: should run out-of-band in batches
- **Inline ignore**: `-- pgfence: ignore <ruleId>` to suppress specific checks
- **Visibility logic**: skips warnings for tables created in the same migration

## Safe Rewrite Recipes

When pgfence detects a dangerous pattern, it outputs the exact safe alternative:

### ADD COLUMN with NOT NULL + volatile DEFAULT

**Dangerous:**
```sql
ALTER TABLE users ADD COLUMN last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp();
-- ACCESS EXCLUSIVE lock on entire table for duration of rewrite
```

**Safe (expand/contract):**
```sql
-- Migration 1: Add nullable column (instant, no lock)
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Migration 2: Create index (non-blocking)
CREATE INDEX CONCURRENTLY idx_users_last_seen_at ON users(last_seen_at);

-- Out-of-band backfill job (not in migration, repeat until 0 rows updated):
-- WITH batch AS (
--   SELECT ctid FROM users WHERE last_seen_at IS NULL LIMIT 1000 FOR UPDATE SKIP LOCKED
-- )
-- UPDATE users t SET last_seen_at = now() FROM batch WHERE t.ctid = batch.ctid;

-- Migration 3: Add NOT NULL constraint
ALTER TABLE users ADD CONSTRAINT chk_last_seen_at CHECK (last_seen_at IS NOT NULL) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT chk_last_seen_at;
ALTER TABLE users ALTER COLUMN last_seen_at SET NOT NULL;
ALTER TABLE users DROP CONSTRAINT chk_last_seen_at;
```

## CI/CD Integration

### GitHub Actions

Use a concrete migration path or a glob here. The composite action expands `path` itself, so both `migrations/add-users.sql` and `migrations/*.sql` work.

```yaml
- name: Check migration safety
  uses: flvmnt/pgfence@v0.6.1
  with:
    path: migrations/add-users.sql
    max-risk: medium
```

### GitHub PR Comments

```yaml
- name: Analyze migrations
  run: |
    npx @flvmnt/pgfence analyze --output github migrations/*.sql > pgfence-report.md
- name: Comment on PR
  uses: marocchino/sticky-pull-request-comment@v2
  with:
    path: pgfence-report.md
```

### GitHub Code Scanning (SARIF)

Upload pgfence findings to GitHub Code Scanning for inline PR annotations:

```yaml
- name: Analyze migrations
  run: npx @flvmnt/pgfence analyze --output sarif migrations/*.sql > pgfence.sarif
- name: Upload to GitHub Code Scanning
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: pgfence.sarif
```

### GitLab Code Quality

Upload pgfence findings to GitLab's Code Quality widget:

The GitLab reporter emits finding entries, extraction warnings, and a coverage summary entry so unanalyzable SQL still stays visible in CI.

```yaml
# .gitlab-ci.yml
pgfence:
  script:
    - npx @flvmnt/pgfence analyze --output gitlab migrations/*.sql > gl-code-quality-report.json
  artifacts:
    reports:
      codequality: gl-code-quality-report.json
```

## Trace Mode (Verified Analysis)

Run migrations against a real Postgres instance to verify pgfence's static analysis:

```bash
pgfence trace migrations/*.sql
```

Trace mode spins up a disposable Docker Postgres container, executes each statement, and compares actual lock behavior against pgfence's predictions. No credentials needed, no risk to real data.

```bash
# Specific PG version
pgfence trace --pg-version 14 migrations/*.sql

# Custom Docker image (for PostGIS, pgvector, etc.)
pgfence trace --docker-image postgis/postgis:17 migrations/*.sql

# CI mode (also fails on mismatches between static and traced locks)
pgfence trace --ci --max-risk medium migrations/*.sql
```

Each statement gets a verification status:
- **Confirmed**: static prediction matches actual Postgres behavior
- **Mismatch**: static prediction was wrong (trace result takes precedence)
- **Trace-only**: trace found something static analysis missed (e.g., table rewrite)
- **Static-only**: policy/best-practice check that trace cannot verify

Requires Docker. Use `pgfence analyze` for static-only analysis without Docker.

## Exploring pgfence Cloud

The OSS analyzer is the product. We are also exploring a hosted control plane on top of it with a small group of design partners, production teams with painful migration review who need approvals, audit history, and shared policy. There is no public price, no self-serve signup, no waitlist UI. It is a conversation, not a product yet.

If migration review is painful for your team and you want to help shape what governance should look like, [contact@pgfence.com](mailto:contact@pgfence.com).

The OSS CLI works on its own today, with no account, login, or API key. Anything in Cloud will be additive.

## Plugins

pgfence supports custom rules via a plugin system. Create a module that exports rule or policy functions, then reference it in your config:

```bash
pgfence analyze --plugin ./my-rules.js migrations/*.sql
```

Plugin rule IDs are namespaced with `plugin:` to avoid collisions with built-in checks.

## Schema Snapshots

For rules that need to know your actual column types (e.g., distinguishing safe varchar widenings from cross-type rewrites), pgfence can load a schema snapshot:

```bash
pgfence analyze --snapshot pgfence-snapshot.json migrations/*.sql
```

This replaces heuristic guesses with definitive type classification from your database. Generate the snapshot with:

```bash
pgfence snapshot --db-url postgres://readonly@replica:5432/mydb --output pgfence-snapshot.json
```

## Contributing

### Adding a new rule

1. Create `src/rules/your-rule.ts` implementing the check function
2. Add it to the rule pipeline in `src/analyzer.ts`
3. Add test fixtures in `tests/fixtures/`
4. Add tests in `tests/analyzer.test.ts`

### Running locally

```bash
pnpm install
pnpm test        # Run tests
pnpm typecheck   # Type checking
pnpm lint        # Lint
pnpm build       # Compile
```

## License

[MIT](LICENSE) © Munteanu Flavius-Ioan

## Contact

[contact@pgfence.com](mailto:contact@pgfence.com)
