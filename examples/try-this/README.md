# Try pgfence in 30 seconds

A small migration that hides four production-grade footguns. Run pgfence on it and see what a real review pass looks like.

## Run it

```bash
# With pgfence installed globally
npm install -g @flvmnt/pgfence
pgfence analyze examples/try-this/dangerous-migration.sql

# Or one-off, without installing
npx @flvmnt/pgfence analyze examples/try-this/dangerous-migration.sql
```

## What pgfence catches

The migration looks normal. pgfence flags:

1. **`ADD COLUMN ... NOT NULL DEFAULT now()`**: `ACCESS EXCLUSIVE` lock for the duration of a full table rewrite. Volatile defaults force a rewrite even on PG11+.
2. **`ADD CONSTRAINT ... FOREIGN KEY` without `NOT VALID`**: `SHARE ROW EXCLUSIVE` on both tables, full scan to validate existing rows.
3. **`CREATE INDEX` without `CONCURRENTLY`**: `SHARE` lock blocks all writes for the duration of the build.
4. **Missing `SET lock_timeout`**: policy violation. Any of the above can sit in the lock queue forever, behind another transaction holding a row lock.

Each finding includes the safe rewrite recipe pgfence recommends, ready to paste into the next migration.

## Found a gap?

If pgfence missed something dangerous in your real migration history, or flagged something that is actually safe, please [open an issue](https://github.com/flvmnt/pgfence/issues/new/choose) with the SQL. The repo has templates for false negatives, false positives, and unsupported ORM patterns.

Rule gaps are how this tool gets better.
