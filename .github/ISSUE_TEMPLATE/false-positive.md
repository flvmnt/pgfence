---
name: 🟡 False positive (pgfence flagged something safe)
about: pgfence flagged a migration as risky when it is actually safe in your environment.
title: 'False positive: '
labels: 'bug, false-positive'
assignees: ''
---

## The SQL pgfence flagged

Paste the migration statement(s) pgfence flagged.

```sql

```

## What pgfence reported

The full risk / lock-mode / message pgfence emitted. If you can include the rule ID (`--output json` shows it), that helps a lot.

```

```

## Why this is safe in your case

Tell us what makes this statement safe. Some examples of what makes a flagged statement safe in practice:

- Postgres version sensitivity (e.g. `ALTER TYPE ADD VALUE` is instant on PG12+)
- Table size (e.g. < 1k rows so the lock window is trivial)
- The table is brand new in the same migration
- The constraint was already pre-built concurrently
- A specific CHECK / index already proves the invariant
- Other context pgfence cannot see

## Environment

- pgfence version: <!-- e.g. 0.5.1 -->
- CLI invocation: <!-- e.g. `pgfence analyze --min-pg-version 14 migrations/*.sql` -->
- Postgres version (if relevant):
- ORM (if any): <!-- raw SQL / TypeORM / Prisma / Knex / Sequelize / Drizzle -->

## Suggested fix

Optional. What should the rule do instead? Lower the risk, refine the condition, or skip the statement entirely?
