---
title: The ALTER TABLE that took down our API for 6 minutes
published: true
description: Every DDL statement in Postgres takes a lock. Some block all reads and writes. Here's how to catch them before they hit production.
tags: postgres, database, devops, typescript
cover_image: https://pgfence.com/og-image.png
---

Last Tuesday at 2:47 PM, we deployed a migration that looked completely innocent:

```sql
ALTER TABLE users ADD COLUMN email_verified boolean NOT NULL;
CREATE INDEX idx_users_email ON users(email);
```

Two statements. Nothing exotic. The kind of thing you've written a hundred times.

At 2:48 PM, every API endpoint that touched the `users` table started timing out. Our health checks went red. PagerDuty fired. Customers couldn't log in.

At 2:54 PM,six minutes later,the migration finished and everything recovered on its own.

**The root cause wasn't a bug. It was a lock.**

## What actually happened

Every DDL statement in Postgres acquires a lock on the table it modifies. The lock type depends on the statement:

| Statement | Lock Mode | What it blocks |
|-----------|-----------|----------------|
| `ADD COLUMN ... NOT NULL` (no DEFAULT) | ACCESS EXCLUSIVE | **Everything**,reads, writes, DDL |
| `CREATE INDEX` (no CONCURRENTLY) | SHARE | All writes |
| `SELECT` | ACCESS SHARE | Nothing |

`ACCESS EXCLUSIVE` is the nuclear option. It blocks every other operation on the table,including simple `SELECT` queries,until the DDL completes.

On a small table, this takes milliseconds. On our `users` table with 8 million rows, the `ADD COLUMN ... NOT NULL` without a default forces Postgres to rewrite the entire table while holding that lock. Every query stacks up in the lock queue. The queue backs up into connection pool exhaustion. The pool exhaustion cascades to every service.

Six minutes of downtime from a two-line migration.

## The fix we never should have needed

The safe way to add a NOT NULL column is a multi-step expand/contract pattern:

```sql
-- Step 1: Add the column as nullable (instant, no rewrite)
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean;

-- Step 2: Backfill out-of-band in batches (not in a migration)
-- UPDATE users SET email_verified = false WHERE email_verified IS NULL LIMIT 1000;

-- Step 3: Add the constraint without validating (brief lock)
ALTER TABLE users ADD CONSTRAINT chk_nn
  CHECK (email_verified IS NOT NULL) NOT VALID;

-- Step 4: Validate (reads table but doesn't block writes)
ALTER TABLE users VALIDATE CONSTRAINT chk_nn;

-- Step 5: Now it's safe to enforce
ALTER TABLE users ALTER COLUMN email_verified SET NOT NULL;
ALTER TABLE users DROP CONSTRAINT chk_nn;
```

And that `CREATE INDEX`? Should have been:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email ON users(email);
```

`CONCURRENTLY` takes longer but only requires a `SHARE UPDATE EXCLUSIVE` lock,it allows reads *and* writes to continue.

Every experienced Postgres DBA knows these patterns. The problem is that migrations are written by application developers who don't. And code review doesn't catch lock modes,they're not visible in the SQL.

## pgfence: catch it before your users do

We built [pgfence](https://pgfence.com) to make these problems visible before they reach production. It's a CLI that analyzes your migration files and reports exactly what each statement locks, what it blocks, and how to fix it.

```bash
$ npx @flvmnt/pgfence analyze migrations/add_verified.sql
```

Output:

```
migrations/add_verified.sql  [HIGH]
Lock: ACCESS EXCLUSIVE | Blocks: reads+writes+DDL

#  Statement                                        Lock Mode         Blocks           Risk
1  ALTER TABLE users ADD COLUMN email_verified ...   ACCESS EXCLUSIVE  reads,writes,DDL HIGH
2  CREATE INDEX idx_users_email ON users(email)      SHARE             writes,DDL       MEDIUM

Safe Rewrite Recipe:
  add-column-not-null-no-default: Add nullable column, backfill, then add NOT NULL constraint

    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean;
    -- Backfill out-of-band in batches
    ALTER TABLE users ADD CONSTRAINT chk_nn CHECK (email_verified IS NOT NULL) NOT VALID;
    ALTER TABLE users VALIDATE CONSTRAINT chk_nn;
    ALTER TABLE users ALTER COLUMN email_verified SET NOT NULL;
    ALTER TABLE users DROP CONSTRAINT chk_nn;

Policy Violations:
  ERROR  Missing SET lock_timeout,lock queue death spiral risk
  → Add SET lock_timeout = '2s'; at the start of the migration

Analyzed: 2 statements | Unanalyzable: 0 | Coverage: 100%
```

It tells you:
1. **What lock mode** each statement takes
2. **What it blocks** (reads, writes, DDL)
3. **The risk level** (LOW / MEDIUM / HIGH / CRITICAL)
4. **The safe rewrite**,the exact SQL to use instead
5. **Policy violations**,missing `lock_timeout`, `CONCURRENTLY` inside a transaction, etc.

## How it works

pgfence doesn't use regex to guess at SQL patterns. It uses [libpg_query](https://github.com/pganalyze/libpg_query),PostgreSQL's actual parser, compiled to a C library and exposed via Node.js bindings. The same parser that Postgres itself uses to understand your SQL.

This means it handles edge cases that regex-based tools miss:

```sql
-- pgfence correctly identifies this as safe (PG11+ metadata-only):
ALTER TABLE t ADD COLUMN status text DEFAULT 'active';

-- And this as dangerous (volatile default forces rewrite):
ALTER TABLE t ADD COLUMN created_at timestamptz DEFAULT now();
```

### 42 checks across the full DDL surface

Not just `ADD COLUMN` and `CREATE INDEX`. pgfence covers:

- **Critical**: `DROP TABLE`, `TRUNCATE`, `REINDEX SCHEMA/DATABASE`
- **High**: `ADD FOREIGN KEY` without `NOT VALID`, `ADD UNIQUE` without concurrent index, `VACUUM FULL`, `ATTACH PARTITION`, `REFRESH MATERIALIZED VIEW`
- **Medium**: `SET NOT NULL` without pre-validated constraint, `ALTER TYPE ADD VALUE` on PG < 12, `CREATE/DROP TRIGGER`
- **Low**: Safe patterns it recognizes and doesn't flag,`ADD COLUMN DEFAULT <constant>` on PG11+, `ADD UNIQUE USING INDEX`, `DETACH PARTITION CONCURRENTLY`

### Works with your ORM

pgfence extracts SQL from ORM migration files:

```bash
# TypeORM
pgfence analyze --format typeorm src/migrations/*.ts

# Knex
pgfence analyze --format knex migrations/*.ts

# Prisma (analyzes the generated SQL files)
pgfence analyze prisma/migrations/**/migration.sql

# Plain SQL
pgfence analyze migrations/*.sql
```

It handles `queryRunner.query()` calls in TypeORM, `knex.raw()` and builder chains in Knex, `queryInterface` calls in Sequelize, and Drizzle migrations.

### One line in CI

```yaml
# .github/workflows/migration-check.yml
- name: Check migrations
  run: npx @flvmnt/pgfence analyze --ci --max-risk medium migrations/*.sql
```

Exit code 1 on HIGH risk or above. The build fails before the migration reaches production.

### Optional: table-size-aware scoring

A `CREATE INDEX` on a 500-row lookup table is fine. The same statement on a 50M-row events table is a production incident. pgfence can adjust risk levels based on table sizes:

```bash
# Export table stats from your read replica in CI, then save them as pgfence-stats.json
npx @flvmnt/pgfence analyze --stats-file pgfence-stats.json migrations/*.sql
```

pgfence never asks for database credentials directly. The stats export runs in your CI environment using your existing secrets.

## Why not Eugene / Squawk / strong_migrations?

Those are excellent tools. Here's what's different:

| | pgfence | Eugene | Squawk | strong_migrations |
|---|---|---|---|---|
| Language | TypeScript | Rust | Rust | Ruby |
| ORM extraction | TypeORM, Knex, Prisma, Sequelize, Drizzle | SQL only | SQL only | Rails only |
| Safe rewrite output | Full SQL recipes | Warnings only | Warnings only | Suggestions |
| Table-size scoring | Yes (via stats snapshot) | No | No | No |
| Lock mode mapping | All 8 PG lock modes | Yes | Partial | No |

If you're a Rails shop, strong_migrations is the right choice. If you're in the Node/TypeScript ecosystem with TypeORM or Knex or Prisma,pgfence was built for you.

## Get started

```bash
npm install -D @flvmnt/pgfence
```

Analyze your existing migrations:

```bash
npx @flvmnt/pgfence analyze migrations/*.sql
```

You'll probably find at least one statement you didn't know was dangerous.

---

[GitHub](https://github.com/flvmnt/pgfence) · [Docs](https://pgfence.com/docs/introduction) · [npm](https://www.npmjs.com/package/@flvmnt/pgfence)
