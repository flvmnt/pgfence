# CLAUDE.md — pgfence

## Critical Rules

### 1. Monorepo Structure — Cloud Separation
This is a monorepo. The open-source CLI lives in `src/`. The paid cloud layer lives in `src/cloud/` and `src/agent/`. These directories are EXCLUDED from git via `.git/info/exclude` and must NEVER be committed, pushed, or referenced from public code.

- `src/cloud/` and `src/agent/` are local-only development directories
- `tests/cloud/` contains cloud tests, also excluded from git
- The public CLI (`src/index.ts`) must NEVER import from `./cloud/` or `./agent/`
- tsconfig.json, vitest.config.ts, and eslint.config.js all exclude cloud paths
- When building for npm publish, only `src/` (minus cloud/agent) is compiled
- A pre-push hook and CI check enforce that no cloud/agent files are ever pushed

### 3. No Em Dashes
- NEVER use em dashes (—) in any output: code, docs, blog posts, commit messages, PR descriptions, issues
- Use commas or colons instead

### 4. Website Domain is pgfence.com
- The ONLY correct domain is **pgfence.com**
- NEVER use pgfence.dev, pgfence.io, or any other domain
- All links, docs, PRs, and references must use https://pgfence.com

### 2. No AI Attribution — Ever
- NEVER include `Co-Authored-By` lines mentioning Claude, Anthropic, or any AI tool
- NEVER include "Generated with Claude Code" or similar attribution
- NEVER reference Claude, Anthropic, GPT, Copilot, LLM, or "AI-assisted/generated" anywhere
- Commit author must always be `flvmnt` / `Munteanu Flavius-Ioan <flavius.mnt11@gmail.com>`
- No AI tool names in source code, comments, commit messages, PR descriptions, or docs

---

## Project Overview

pgfence is a Postgres migration safety CLI that analyzes SQL migration files and reports lock modes, risk levels, and safe rewrite recipes. It is the **first TypeScript/Node.js native tool** in this space — existing tools are Ruby (strong_migrations), Rust (Eugene, Squawk), or Go (pgroll).

**Core value proposition**: "We tell you what lock modes each statement takes, what it blocks, and give you the safe expand/contract sequence — before you merge."

## Tech Stack

- **Language**: TypeScript (strict mode)
- **SQL Parser**: `libpg-query` (Node.js bindings to PostgreSQL's actual parser via libpg_query)
- **Test Framework**: Vitest
- **Output Formats**: CLI table (color-coded), JSON, GitHub PR comment markdown
- **Package Manager**: pnpm
- **Node.js**: 20+

## Architecture

```
src/
  index.ts          — CLI entry point (commander/yargs)
  parser.ts         — SQL parsing via libpg-query, returns AST nodes
  analyzer.ts       — Maps parsed statements to lock modes + risk levels
  rules/            — Individual check implementations (one file per footgun)
    add-column.ts   — ADD COLUMN with/without DEFAULT, NOT NULL
    create-index.ts — CREATE INDEX with/without CONCURRENTLY
    alter-column.ts — ALTER COLUMN TYPE, SET NOT NULL, SET DEFAULT
    add-constraint.ts — FOREIGN KEY, CHECK, UNIQUE, EXCLUDE constraints
    destructive.ts  — DROP TABLE, TRUNCATE, DELETE without WHERE
    policy.ts       — lock_timeout, statement_timeout, application_name, tx warnings
  extractors/       — Extract SQL from ORM migration formats
    raw-sql.ts      — Plain .sql files
    typeorm.ts      — Extract queryRunner.query() strings from TypeORM migrations
    prisma.ts       — Extract from Prisma migration SQL files (prisma/migrations/**/migration.sql)
    knex.ts         — Extract from knex.raw() calls
  reporters/
    cli.ts          — Terminal table output with color-coded risk levels
    json.ts         — Machine-readable JSON output
    github-pr.ts    — GitHub PR comment markdown
  db-stats.ts       — Optional DB connection for size-aware risk scoring
  types.ts          — Shared types (LockMode, RiskLevel, CheckResult, SafeRewrite, etc.)
  cloud/            — [LOCAL ONLY] pgfence Cloud integration (not tracked in git)
  agent/            — [LOCAL ONLY] Secure Agent for DB metadata (not tracked in git)
tests/
  fixtures/         — Sample migration files (safe + dangerous patterns)
  analyzer.test.ts  — Core analyzer tests
```

## Postgres Lock Mode Reference

This is the source of truth for pgfence's analysis. Each DDL statement maps to a lock mode:

| Lock Mode | Blocks | Severity |
|-----------|--------|----------|
| ACCESS SHARE | Nothing | Safe |
| ROW SHARE | ROW EXCLUSIVE+ | Low |
| ROW EXCLUSIVE | SHARE+ | Low |
| SHARE UPDATE EXCLUSIVE | SHARE UPDATE EXCLUSIVE+ | Medium |
| SHARE | ROW EXCLUSIVE+ (blocks writes) | Medium |
| SHARE ROW EXCLUSIVE | ROW EXCLUSIVE+ | High |
| EXCLUSIVE | ROW SHARE+ | High |
| ACCESS EXCLUSIVE | Everything (blocks reads + writes) | Critical |

### DDL → Lock Mode Mapping (v1 Checks)

| # | Pattern | Lock Mode | Risk | Safe Alternative |
|---|---------|-----------|------|------------------|
| 1 | `ADD COLUMN ... NOT NULL` without DEFAULT | ACCESS EXCLUSIVE | HIGH | Add nullable, backfill, SET NOT NULL |
| 2 | `ADD COLUMN ... DEFAULT <volatile>` | ACCESS EXCLUSIVE | HIGH | Add without default, backfill in batches |
| 3 | `ADD COLUMN ... DEFAULT <constant>` (PG11+) | ACCESS EXCLUSIVE (instant) | LOW | Safe on PG11+ (metadata-only) |
| 4 | `CREATE INDEX` (non-concurrent) | SHARE | MEDIUM | `CREATE INDEX CONCURRENTLY` |
| 5 | `DROP INDEX` (non-concurrent) | ACCESS EXCLUSIVE | MEDIUM | `DROP INDEX CONCURRENTLY` |
| 6 | `ALTER COLUMN TYPE` | ACCESS EXCLUSIVE | HIGH | Expand/contract pattern |
| 7 | `ALTER COLUMN SET NOT NULL` | ACCESS EXCLUSIVE | MEDIUM | CHECK constraint NOT VALID + validate |
| 8 | `ADD CONSTRAINT ... FOREIGN KEY` | SHARE ROW EXCLUSIVE (both tables) | HIGH | NOT VALID + VALIDATE CONSTRAINT |
| 9 | `ADD CONSTRAINT ... CHECK` | SHARE ROW EXCLUSIVE | MEDIUM | NOT VALID + VALIDATE CONSTRAINT |
| 10 | `ADD CONSTRAINT ... UNIQUE` | SHARE ROW EXCLUSIVE | HIGH | CONCURRENTLY unique index + USING INDEX |
| 11 | `DROP TABLE` | ACCESS EXCLUSIVE | CRITICAL | Separate release |
| 12 | `TRUNCATE` | ACCESS EXCLUSIVE | CRITICAL | Batched DELETE |
| 13 | `ADD CONSTRAINT ... EXCLUDE` | SHARE ROW EXCLUSIVE | HIGH | Build index concurrently first |
| 14 | `RENAME COLUMN` | ACCESS EXCLUSIVE | LOW | Instant on PG14+ |
| 15 | `VACUUM FULL` | ACCESS EXCLUSIVE | HIGH | Use pg_repack |

### Policy Checks

1. **Missing `SET lock_timeout`** — Every migration MUST set lock_timeout (default recipe: `'2s'`). Prevents lock queue death spiral.
2. **Missing `SET statement_timeout`** — Long operations need a timeout.
3. **`CREATE INDEX CONCURRENTLY` inside transaction** — Will fail. Must run outside tx.
4. **`SET application_name`** — Recommended for all migrations (enables `pg_stat_activity` visibility).
5. **`SET idle_in_transaction_session_timeout`** — Recommended `'30s'` to prevent orphaned locks.
6. **Large UPDATE/backfill inside migration** — Should be out-of-band with `FOR UPDATE SKIP LOCKED` batching.

### DB-Size-Aware Risk Scoring

When table stats are provided, pgfence adjusts risk levels:

```
< 10K rows    → risk stays as-is
10K - 1M rows → risk + 1 level
1M - 10M rows → risk + 2 levels
> 10M rows    → CRITICAL regardless
```

#### Stats Snapshot Method (Recommended)

pgfence never asks for or receives database credentials. Instead:

1. Customer's CI pipeline runs `pgfence extract-stats` (a provided script) that connects to their read replica using their existing CI secrets
2. Script runs the `pg_stat_user_tables` query and outputs `pgfence-stats.json`
3. `pgfence analyze --stats-file pgfence-stats.json` consumes the artifact locally

This avoids VPC agents, security reviews, and procurement friction. The customer controls the database connection entirely.

#### Direct Connection (Development/Testing)

For local development or when direct access is acceptable, `--db-url` is still supported:

```bash
pgfence analyze --db-url postgres://readonly@replica:5432/mydb migrations/*.sql
```

Query used:
```sql
SELECT schemaname, relname, n_live_tup,
       pg_total_relation_size(relid) as total_bytes
FROM pg_stat_user_tables
ORDER BY n_live_tup DESC;
```

## Safe Rewrite Recipes

When pgfence detects a dangerous pattern, it outputs the correct expand/contract sequence.

### Recipe: ADD COLUMN with NOT NULL + DEFAULT

Split into 3 migrations + 1 out-of-band backfill:

1. **Expand**: `ALTER TABLE t ADD COLUMN IF NOT EXISTS col type;` (instant, no lock)
2. **Index**: `CREATE INDEX CONCURRENTLY ...;` (outside transaction)
3. **Backfill** (out-of-band job): `UPDATE ... WHERE col IS NULL ... LIMIT 1000 FOR UPDATE SKIP LOCKED` in batches
4. **Contract**: `ADD CONSTRAINT ... CHECK (col IS NOT NULL) NOT VALID;` then `VALIDATE CONSTRAINT;` then `ALTER COLUMN SET NOT NULL;` then drop helper constraint

### Recipe: ADD FOREIGN KEY

```sql
ALTER TABLE t ADD CONSTRAINT fk ... REFERENCES ... NOT VALID;  -- brief lock
ALTER TABLE t VALIDATE CONSTRAINT fk;                          -- non-blocking scan
```

### Recipe: ADD UNIQUE CONSTRAINT

```sql
CREATE UNIQUE INDEX CONCURRENTLY idx ON t(col);            -- non-blocking
ALTER TABLE t ADD CONSTRAINT uq UNIQUE USING INDEX idx;    -- brief lock
```

### Recipe: CREATE INDEX

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx ON t(col);     -- allows reads + writes
```

## Commands

```bash
pnpm dev          # Watch mode
pnpm build        # Compile TypeScript
pnpm test         # Run tests
pnpm lint         # Lint
pnpm typecheck    # Type checking
```

## CLI Usage (Target)

```bash
# Analyze SQL files
pgfence analyze migrations/*.sql

# Analyze TypeORM migrations
pgfence analyze --format typeorm src/migrations/*.ts

# With DB stats for size-aware scoring
pgfence analyze --db-url postgres://readonly@replica:5432/mydb migrations/*.sql

# Output as JSON
pgfence analyze --output json migrations/*.sql

# Output as GitHub PR comment
pgfence analyze --output github migrations/*.sql

# CI mode (exit code 1 on HIGH+ risk)
pgfence analyze --ci --max-risk medium migrations/*.sql
```

## Related Tools

| Tool | Language | Scope |
|------|----------|-------|
| strong_migrations | Ruby | Rails/ActiveRecord migration checks |
| Eugene | Rust | Postgres DDL lint + trace modes |
| Squawk | Rust | SQL linter + GitHub Action |
| pgroll | Go | Migration executor (different category) |
| **pgfence** | **TypeScript** | **Multi-ORM, DB-size-aware, safe rewrites** |

## Testing Strategy

- **Fixture-based**: `tests/fixtures/` contains migration files with known patterns (safe + dangerous)
- **Snapshot tests**: Expected analyzer output per fixture
- **Real-world validation**: Run against production TypeORM migration suites
- **Lock mode correctness**: Each check's lock mode assignment verified against Postgres docs

## Development Conventions

- Strict TypeScript (no `any`)
- No silent catch blocks
- Tests for every rule
- Keep rules isolated (one file per check category)
- Extractors are pluggable (easy to add new ORM support)

## Trust Contract

pgfence's fatal failure mode is not false positives — it is **false negatives** (silently passing dangerous migrations) or **false safety implied** (not surfacing what we couldn't analyze). The Trust Contract defines how pgfence earns and keeps developer trust.

### Output Semantics

| State | Meaning | Exit Code |
|-------|---------|-----------|
| SAFE | Fully analyzed, matches known safe pattern | 0 |
| WARNING | Fully analyzed, contains known footgun. Safe Rewrite provided. | 0 (or 1 if `--max-risk` exceeded) |
| ERROR | Policy violation (missing lock_timeout, CONCURRENTLY in tx) | 1 |
| UNKNOWN | Could not statically analyze (dynamic SQL, computed identifiers) | Configurable: warn-only or block |

### UNKNOWN Handling

- Extractors encountering dynamic SQL (template literal interpolations, non-literal args) MUST emit an `ExtractionWarning` — never silently skip
- UNKNOWN is configurable: `warn` (default, for early adoption) or `block` (for strict orgs)
- Current implementation: TypeORM/Knex extractors already emit warnings for dynamic SQL. No silent failures exist today.

### Coverage Guarantee

- Every report (CLI, JSON, GitHub) MUST include a coverage summary line
- Format: `"Analyzed X SQL statements. Y dynamic statements not analyzable (lines A, B)."`
- A report with UNKNOWN statements and no coverage line is a bug

## Monetization Philosophy

pgfence monetizes the **organizational control plane** (policies, approvals, audit trail, exemptions), NOT the analyzer itself. The CLI + GitHub Action remain free forever. Companies pay for workflow enforcement and accountability — the ability to centrally manage who can approve risky migrations, track every decision in an immutable audit log, and enforce policies that individual developers cannot bypass.
