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
    <p><strong>The only migration linter that understands your ORM: TypeORM, Prisma, Knex, Drizzle, Sequelize.</strong></p>
    <p>
      <a href="https://github.com/flvmnt/pgfence/actions/workflows/ci.yml"><img src="https://github.com/flvmnt/pgfence/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
      <a href="https://www.npmjs.com/package/@flvmnt/pgfence"><img src="https://img.shields.io/npm/v/@flvmnt/pgfence" alt="npm" /></a>
      <a href="https://www.npmjs.com/package/@flvmnt/pgfence"><img src="https://img.shields.io/npm/dw/@flvmnt/pgfence" alt="npm downloads" /></a>
      <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
      <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg" alt="Node.js" /></a>
      <a href="https://marketplace.visualstudio.com/items?itemName=flvmnt.pgfence"><img src="https://img.shields.io/visual-studio-marketplace/v/flvmnt.pgfence?label=VS%20Code" alt="VS Code" /></a>
      <a href="https://pgfence.com"><img src="https://img.shields.io/badge/website-pgfence.com-blue" alt="Website" /></a>
    </p>
  </td>
</tr></table>

---

## The Problem

Your ORM migration just took down production for 47 seconds.

A seemingly innocent `ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT false` grabbed an `ACCESS EXCLUSIVE` lock on your 12M-row users table. Every query queued behind it. Your healthchecks failed. Pods restarted. Customers noticed.

This happens because ORMs hide the Postgres lock semantics from you. You can't fix what you can't see.

## What pgfence Does

pgfence analyzes your SQL migration files **before they hit production** and tells you:

1. **What lock mode** each DDL statement acquires and **what it blocks** (reads, writes, or both)
2. **Risk level** for each operation, optionally adjusted by actual table size from your database
3. **Safe rewrite recipes**, the exact expand/contract sequence to run instead

Works with **raw SQL**, **TypeORM**, **Prisma**, **Knex**, **Drizzle**, and **Sequelize** migrations. No Ruby, no Rust, no Go. Just TypeScript.

## Quick Demo

```
$ pgfence analyze migrations/add-email-verified.sql

pgfence - Migration Safety Report

┌─────────────────────────────────────────────────┬──────────────────┬──────────┬────────┐
│ Statement                                       │ Lock Mode        │ Blocks   │ Risk   │
├─────────────────────────────────────────────────┼──────────────────┼──────────┼────────┤
│ ALTER TABLE users ADD COLUMN email_verified     │ ACCESS EXCLUSIVE │ R + W    │ HIGH   │
│ BOOLEAN NOT NULL DEFAULT false                  │                  │          │        │
├─────────────────────────────────────────────────┼──────────────────┼──────────┼────────┤
│ CREATE INDEX idx_users_email ON users(email)    │ SHARE            │ W        │ MEDIUM │
└─────────────────────────────────────────────────┴──────────────────┴──────────┴────────┘

Policy Violations:
  ✗ Missing SET lock_timeout: add SET lock_timeout = '2s' at the start

Safe Rewrites:
  1. ADD COLUMN with NOT NULL + DEFAULT → split into expand/backfill/contract:
     • ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN;
     • Backfill in batches: WITH batch AS (SELECT ctid FROM users WHERE email_verified IS NULL LIMIT 1000 FOR UPDATE SKIP LOCKED) UPDATE users t SET email_verified = <fill_value> FROM batch WHERE t.ctid = batch.ctid;
     • ALTER TABLE users ADD CONSTRAINT ... CHECK (email_verified IS NOT NULL) NOT VALID;
     • ALTER TABLE users VALIDATE CONSTRAINT ...;

  2. CREATE INDEX → use CONCURRENTLY:
     • CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email ON users(email);

=== Coverage ===
Analyzed: 2 statements  |  Unanalyzable: 0  |  Coverage: 100%
```

## Postgres Version Support

pgfence is tested against **PostgreSQL 14 through 17**. The default assumption is PG 14+ (the oldest version still supported by the PostgreSQL project). Use `--min-pg-version` to override if needed:

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

When dynamic SQL is detected (TypeORM/Knex extractors), pgfence emits a warning rather than silently skipping it. Every report includes a coverage line showing how many statements were analyzed vs. skipped.

To explicitly acknowledge a statement pgfence cannot analyze, add `-- pgfence-ignore` before it, see [Suppressing warnings](#suppressing-warnings).

## Alternatives

Other tools in this space worth knowing about:

| Tool | Language | Rules | Focus |
|------|----------|-------|-------|
| [Squawk](https://github.com/sbdchd/squawk) | Rust | 32 | SQL linter with GitHub Action |
| [Eugene](https://github.com/kaaveland/eugene) | Rust | 12 | DDL lint + trace modes |
| [strong_migrations](https://github.com/ankane/strong_migrations) | Ruby | 21 | Rails/ActiveRecord migration checks |
| [pgroll](https://github.com/xataio/pgroll) | Go | - | Migration **executor** (runs migrations with rollback). Complementary to pgfence. |
| **pgfence** | **TypeScript** | **42** | **Multi-ORM, DB-size-aware, safe rewrites** |

pgfence is the only linter that analyzes ORM migration files (TypeORM, Prisma, Knex, Drizzle, Sequelize), with full AST-walking transpilers that convert builder patterns into analyzable SQL. It also provides DB-size-aware risk scoring and complete expand/contract rewrite recipes.

pgroll is not a competitor: it is a runtime executor (runs migrations with automatic rollback). pgfence analyzes before you run; pgroll handles how you run. They are complementary.

pgfence is featured in the [pglt Related Work](https://github.com/supabase-community/postgres-language-server/blob/main/docs/reference/related_work.md) page (postgres-language-server, Supabase community).

## VS Code Extension

Get real-time migration safety analysis directly in your editor:

- **Inline diagnostics**: lock modes, risk levels, and policy violations as you type
- **Quick fixes**: one-click safe rewrite replacements
- **Hover info**: lock mode, blocked operations, and safe alternatives

**[Install from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=flvmnt.pgfence)** or search "pgfence" in the Extensions panel. Requires `@flvmnt/pgfence` installed in your project or globally. See the [extension docs](https://pgfence.com/docs/editor) for configuration and commands.

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
# Exit 1 if any check exceeds MEDIUM risk
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

pgfence checks 42 DDL patterns against Postgres's lock mode semantics:

### Lock & Safety Checks

| # | Pattern | Lock Mode | Risk | Safe Alternative |
|---|---------|-----------|------|------------------|
| 1 | `ADD COLUMN ... NOT NULL` (no DEFAULT) | ACCESS EXCLUSIVE | HIGH | Add nullable, backfill, SET NOT NULL |
| 2 | `ADD COLUMN ... DEFAULT <volatile>` | ACCESS EXCLUSIVE | HIGH | Add without default, backfill in batches |
| 3 | `ADD COLUMN ... DEFAULT <constant>` | ACCESS EXCLUSIVE (instant) | LOW | Safe on PG11+ (metadata-only) |
| 4 | `ADD COLUMN ... GENERATED STORED` | ACCESS EXCLUSIVE | HIGH | Add regular column + trigger + backfill |
| 5 | `CREATE INDEX` (non-concurrent) | SHARE | MEDIUM | `CREATE INDEX CONCURRENTLY` |
| 6 | `DROP INDEX` (non-concurrent) | ACCESS EXCLUSIVE | MEDIUM | `DROP INDEX CONCURRENTLY` |
| 7 | `ALTER COLUMN TYPE` (text/varchar widening) | ACCESS EXCLUSIVE | LOW | Metadata-only, no table rewrite |
| | `ALTER COLUMN TYPE varchar(N)` | ACCESS EXCLUSIVE | MEDIUM | Safe if widening; verify with schema |
| | `ALTER COLUMN TYPE` (cross-family) | ACCESS EXCLUSIVE | HIGH | Expand/contract pattern |
| 8 | `ALTER COLUMN SET NOT NULL` | ACCESS EXCLUSIVE | MEDIUM | CHECK constraint NOT VALID + validate |
| 9 | `ADD CONSTRAINT ... FOREIGN KEY` | SHARE ROW EXCLUSIVE | HIGH | NOT VALID + VALIDATE CONSTRAINT |
| 10 | `ADD CONSTRAINT ... CHECK` | SHARE ROW EXCLUSIVE | MEDIUM | NOT VALID + VALIDATE CONSTRAINT |
| 11 | `ADD CONSTRAINT ... UNIQUE` | SHARE ROW EXCLUSIVE | HIGH | CONCURRENTLY unique index + USING INDEX |
| | `ADD CONSTRAINT ... UNIQUE USING INDEX` | SHARE UPDATE EXCLUSIVE | LOW | Instant, attaches pre-built index |
| 12 | `ADD CONSTRAINT ... EXCLUDE` | SHARE ROW EXCLUSIVE | HIGH | No concurrent alternative; use lock_timeout |
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
| | `ATTACH PARTITION` (PG12+) | SHARE UPDATE EXCLUSIVE | MEDIUM | Briefly locks parent; CHECK constraint helps |
| 22 | `DETACH PARTITION` (non-concurrent) | ACCESS EXCLUSIVE | HIGH | `DETACH PARTITION CONCURRENTLY` (PG14+) |
| 23 | `REFRESH MATERIALIZED VIEW` | ACCESS EXCLUSIVE | HIGH | `REFRESH MATERIALIZED VIEW CONCURRENTLY` |
| | `REFRESH MATERIALIZED VIEW CONCURRENTLY` | EXCLUSIVE | MEDIUM | Blocks writes; requires unique index |
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
- **Missing `SET statement_timeout`**: safety net for long operations
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

### ADD COLUMN with NOT NULL + DEFAULT

**Dangerous:**
```sql
ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT false;
-- ACCESS EXCLUSIVE lock on entire table for duration of rewrite
```

**Safe (expand/contract):**
```sql
-- Migration 1: Add nullable column (instant, no lock)
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN;

-- Migration 2: Create index (non-blocking)
CREATE INDEX CONCURRENTLY idx_users_email_verified ON users(email_verified);

-- Out-of-band backfill job (not in migration, repeat until 0 rows updated):
-- WITH batch AS (
--   SELECT ctid FROM users WHERE email_verified IS NULL LIMIT 1000 FOR UPDATE SKIP LOCKED
-- )
-- UPDATE users t SET email_verified = false FROM batch WHERE t.ctid = batch.ctid;

-- Migration 3: Add NOT NULL constraint
ALTER TABLE users ADD CONSTRAINT chk_email_verified CHECK (email_verified IS NOT NULL) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT chk_email_verified;
ALTER TABLE users ALTER COLUMN email_verified SET NOT NULL;
ALTER TABLE users DROP CONSTRAINT chk_email_verified;
```

## CI/CD Integration

### GitHub Actions

```yaml
- name: Check migration safety
  uses: flvmnt/pgfence@v1
  with:
    path: migrations/*.sql
    max-risk: medium
```

### GitHub PR Comments

```yaml
- name: Analyze migrations
  run: |
    npx pgfence analyze --output github migrations/*.sql > pgfence-report.md
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

## pgfence Cloud (Coming Soon)

Upgrade to **pgfence Cloud** for team-grade migration safety:

- **Approval workflows**: require sign-off on HIGH+ risk migrations before merge
- **Exemptions with justification + expiry**: bypass a warning with a recorded reason and expiration date
- **Centralized policies**: enforce org-wide rules (e.g., "block all CRITICAL risk") that individual developers cannot override
- **SOC2 audit logging**: immutable log of every analysis, approval, and bypass
- **Schema drift detection**: compare your migrations against production schema
- **Migration history**: track every analyzed migration across your org

pgfence Cloud never asks for database credentials. DB-size-aware scoring uses a stats snapshot: your CI runs a provided script against your read replica, outputs a JSON file, and pgfence consumes it locally.

Learn more at **[pgfence.com](https://pgfence.com)**.

All cloud features are additive. The source-available CLI works exactly the same without an API key.

## Plugins

pgfence supports custom rules via a plugin system. Create a module that exports rule or policy functions, then reference it in your config:

```bash
pgfence analyze --plugin ./my-rules.js migrations/*.sql
```

Plugin rule IDs are namespaced with `plugin:` to avoid collisions with built-in checks.

## Schema Snapshots

For rules that need to know your actual column types (e.g., distinguishing safe varchar widenings from cross-type rewrites), pgfence can load a schema snapshot:

```bash
pgfence analyze --schema-file pgfence-schema.json migrations/*.sql
```

This replaces heuristic guesses with definitive type classification from your database. Generate the snapshot with `pgfence extract-schema` against a read replica.

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
