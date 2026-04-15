---
title: I built a tool that runs your Postgres migrations before they hit production
published: true
description: pgfence trace spins up a disposable Docker Postgres, executes your migrations, and shows which locks were observed during execution. Here's how it works.
tags: postgres, database, docker, typescript
cover_image: https://pgfence.com/og-image.png
---

Last month I shipped [pgfence](https://pgfence.com), a CLI that tells you what lock modes your Postgres migrations take and how to rewrite them safely. It works by parsing your SQL and looking up each DDL statement in a lock mode table.

The feedback I kept getting: "How do I know your lookup table is right?"

Fair question. So I built trace mode.

## What trace mode does

```bash
npx @flvmnt/pgfence trace migrations/add-verified.sql
```

```
pgfence - Trace Report (PostgreSQL 17, Docker)

  migrations/add-verified.sql  [HIGH]

  #  Statement                          Lock Mode         Blocks  Risk    Verified    Duration
  1  ALTER TABLE users ADD COLUMN       ACCESS EXCLUSIVE  R + W   HIGH    Confirmed   2ms
     email_verified BOOLEAN NOT NULL
  2  CREATE INDEX idx ON users(email)   SHARE             W       MEDIUM  Confirmed   1ms

  Trace-Only Findings:
  ! Table rewrite detected on "users" (relfilenode changed)

  === Coverage ===
  Analyzed: 2 statements | Verified: 2/2 | Mismatches: 0 | Trace-only: 1
  Docker: postgres:17-alpine | Container lifetime: 4.2s
```

Every statement gets a verification status:

- **Confirmed**: pgfence's static prediction matched real Postgres behavior
- **Mismatch**: the prediction was wrong. You see what actually happened.
- **Trace-only**: something Postgres did that static analysis can't predict (table rewrites, implicit locks on sequences)

## How it works

1. pgfence runs static analysis first (all the normal rules and safe rewrite recipes)
2. Pulls `postgres:17-alpine` and starts a container on a random `127.0.0.1` port
3. Each statement executes inside `BEGIN`/`COMMIT` so locks are held when we snapshot
4. After each statement, diffs: `pg_locks` (lock modes), `pg_class.relfilenode` (table rewrites), `pg_attribute` (column changes), `pg_constraint` (validation state), `pg_index` (index validity)
5. Static predictions are matched against trace observations
6. Container is deleted

The whole thing takes 3-5 seconds for a typical migration file. The container is ephemeral: random password, `127.0.0.1` only, cleaned up even on SIGINT/SIGTERM.

## The CONCURRENTLY problem

`CREATE INDEX CONCURRENTLY` is the most common safe migration pattern. It's also the hardest to trace.

The reason: Postgres rejects `CONCURRENTLY` inside a transaction. If you wrap everything in `BEGIN`/`COMMIT` to hold locks for snapshotting, CONCURRENTLY statements fail.

Eugene (a Rust-based tool with a similar trace feature) solves this by wrapping everything in a transaction and rolling back. CONCURRENTLY statements are just skipped.

pgfence takes a different approach. Since the Docker container is disposable, there's no need for transactions on CONCURRENTLY statements. Instead, pgfence opens a second "observer" connection that polls `pg_locks` every 50ms while the main connection executes the statement. The observer records the lock modes it sees during execution, which is great for practical verification but still leaves room for very short-lived locks to slip between polls.

This means pgfence is the only tool that can verify the lock behavior of `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, `REINDEX CONCURRENTLY`, and `DETACH PARTITION CONCURRENTLY`.

## What trace mode catches that static analysis can't

**Table rewrites.** When Postgres changes a column type, it sometimes rewrites the entire table (new `relfilenode`). Static analysis can detect known rewrite patterns, but trace mode sees the actual rewrite happen by diffing `pg_class.relfilenode` before and after.

**Implicit locks.** Adding a column to a table with a serial column implicitly locks the sequence. Adding a foreign key locks the referenced table. These cascade effects are visible in `pg_locks` but not in the DDL syntax.

**Version-specific behavior.** `ALTER TYPE ADD VALUE` takes EXCLUSIVE on PG12+ but ACCESS EXCLUSIVE on PG11. `ADD COLUMN ... DEFAULT` is instant on PG11+ but rewrites the table on PG10. Trace mode tests against the exact version you specify.

## CI integration

```bash
npx @flvmnt/pgfence trace --ci --max-risk medium migrations/*.sql
```

Exit code 1 if any check exceeds the risk threshold, any mismatch between prediction and reality, or any execution error. Mismatches are CI failures because a mismatch means the static analysis is wrong for that statement.

## Try it

```bash
npm install -D @flvmnt/pgfence
npx @flvmnt/pgfence trace migrations/*.sql
```

Requires Docker. Works with raw SQL, TypeORM, Prisma, Knex, Drizzle, and Sequelize migrations.

If you find a mismatch between pgfence's static analysis and what trace mode observes, please [open an issue](https://github.com/flvmnt/pgfence/issues). Every mismatch report helps make the static analysis more accurate.

[GitHub](https://github.com/flvmnt/pgfence) | [Website](https://pgfence.com) | [npm](https://www.npmjs.com/package/@flvmnt/pgfence)
