---
name: 🚨 False negative (pgfence missed a dangerous pattern)
about: pgfence reported a migration as safe (or did not flag it strongly enough) when it would actually cause problems in production.
title: 'False negative: '
labels: 'bug, false-negative'
assignees: ''
---

## The SQL pgfence missed

Paste the migration statement(s) pgfence underestimated. A minimal repro is fine.

```sql

```

## What pgfence reported

What did pgfence say about this statement? Paste the relevant part of the report (CLI / JSON / GitHub markdown).

```

```

## What actually happens (or what should pgfence catch)

Describe the production behavior pgfence missed. If you have observed it in practice, include any of:

- Lock mode you observed (`pg_locks` / `pg_stat_activity` snapshot if available)
- Approximate impact (blocked reads / blocked writes / duration)
- Postgres version
- Table size (rows + total bytes if known)
- Whether you were in a transaction block

## Environment

- pgfence version: <!-- e.g. 0.5.1, run `pgfence --version` -->
- CLI invocation: <!-- e.g. `pgfence analyze --format typeorm --min-pg-version 14 src/migrations/*.ts` -->
- ORM (if any): <!-- raw SQL / TypeORM / Prisma / Knex / Sequelize / Drizzle -->

## Anything else?

Optional. Links to PG docs, related rules in the codebase, or a guess at which rule should have fired.
