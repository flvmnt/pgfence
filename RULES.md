# pgfence rules reference

A single-file Postgres migration safety catalog, designed for in-editor coding
assistants to ingest as project context. Drop this into your repo (or symlink it
from `docs/`) so your assistant can learn pgfence's conventions and suggest safe
migrations from the first keystroke.

This file is a curated extract of pgfence's runtime checks. The authoritative
analyzer lives in code: `src/rules/*.ts`. Run `pgfence analyze <files>` for the
authoritative verdict on any specific migration.

## Lock mode reference

Each DDL statement acquires a Postgres lock. The lock determines what concurrent
sessions can still do during the statement.

| Lock mode | What it blocks | Severity |
|---|---|---|
| ACCESS SHARE | Nothing concurrent runs slower | Safe |
| ROW SHARE | Other ROW EXCLUSIVE+ holders | Low |
| ROW EXCLUSIVE | Other SHARE+ holders | Low |
| SHARE UPDATE EXCLUSIVE | Concurrent SHARE UPDATE EXCLUSIVE+ | Medium |
| SHARE | Writes blocked, reads allowed | Medium |
| SHARE ROW EXCLUSIVE | Most writes blocked | High |
| EXCLUSIVE | All but ACCESS SHARE | High |
| ACCESS EXCLUSIVE | Everything, including reads | Critical |

## Always do this

Every migration MUST start with:

```sql
SET lock_timeout = '2s';            -- prevent lock-queue death spiral
SET statement_timeout = '5min';     -- cap runtime
SET idle_in_transaction_session_timeout = '30s';  -- prevent orphaned locks
SET application_name = 'migrate:<short-name>';    -- pg_stat_activity visibility
```

## DDL footguns to avoid

### Table rewrites (ACCESS EXCLUSIVE, blocks reads + writes)

- `ALTER COLUMN ... TYPE` (most type changes rewrite the table)
- `ADD COLUMN ... DEFAULT <volatile>` (e.g. `DEFAULT now()`, `DEFAULT uuid_generate_v4()`)
- `ADD COLUMN ... NOT NULL` without a `DEFAULT` (on a non-empty table)
- `VACUUM FULL`, `CLUSTER` (full rewrite to compact)
- `ALTER TABLE ... SET LOGGED` or `SET UNLOGGED`

Safe rewrite for all of these: split into expand + backfill + contract migrations.
Add the column nullable, backfill in batches with `FOR UPDATE SKIP LOCKED`, then
add the NOT NULL via `CHECK ... NOT VALID` + `VALIDATE CONSTRAINT`.

### Brief but blocking (ACCESS EXCLUSIVE, instant)

- `RENAME COLUMN` (instant on PG14+)
- `RENAME TABLE`
- `ALTER COLUMN DROP NOT NULL`
- Adding constraints `USING INDEX` (only ShareUpdateExclusive, not access exclusive)

The lock is brief but ACCESS EXCLUSIVE still queues behind every running
transaction on the table. Always set `lock_timeout` before issuing them.

### Constraint adds (SHARE ROW EXCLUSIVE on the target table)

- `ADD CONSTRAINT ... FOREIGN KEY` (locks BOTH tables in this mode)
- `ADD CONSTRAINT ... CHECK` (writes blocked during full scan to validate)
- `ADD CONSTRAINT ... UNIQUE` without `USING INDEX` (full scan)
- `ADD CONSTRAINT ... EXCLUDE`

Safe rewrite: add the constraint with `NOT VALID`, then `VALIDATE CONSTRAINT` in a
separate transaction. The `NOT VALID` step takes the brief lock; the validation
scan happens with SHARE UPDATE EXCLUSIVE (does not block writes).

### Indexes

- `CREATE INDEX` without `CONCURRENTLY`: blocks writes for the entire build duration
- `DROP INDEX` without `CONCURRENTLY`: ACCESS EXCLUSIVE
- `REINDEX INDEX`: ACCESS EXCLUSIVE; prefer `REINDEX INDEX CONCURRENTLY` (PG12+)
- `REINDEX TABLE`: SHARE lock; still blocks writes

Always:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_name ON t (col);
```

Note: `CREATE INDEX CONCURRENTLY` cannot run inside a transaction. Migration tools
that wrap every migration in `BEGIN/COMMIT` need an opt-out for these statements.

### Production footguns no other linter catches

Most Postgres migration linters miss these, but pgfence flags them:

- **`CLUSTER table USING idx`**: full table rewrite under ACCESS EXCLUSIVE. Use `pg_repack` instead.
- **`ALTER TABLE t REPLICA IDENTITY FULL`**: every UPDATE/DELETE now writes the full old row image to WAL. 10x to 100x amplification. Saturates Debezium / pglogical. Use the primary key (default) or a unique non-null index instead.
- **`ALTER TABLE t ENABLE ROW LEVEL SECURITY`** without prior policies: denies all rows by default. The application appears to lose its data.
- **`ALTER TABLE t DISABLE ROW LEVEL SECURITY`**: silently exposes every row that was previously gated by policies.
- **`DROP SCHEMA s CASCADE`**: silently drops every table, view, function, type, and sequence in the schema. CRITICAL, irreversible.
- **`DROP DATABASE`**: irreversible. Move this to a separate ops procedure, never put it in a migration file.
- **`ALTER TABLE child INHERIT parent`** / `NO INHERIT`: validation scan under ACCESS EXCLUSIVE on both tables.
- **`CREATE TYPE x AS ENUM (...)`**: Postgres has no `ALTER TYPE x DROP VALUE`. If you may ever need to remove a value, prefer a lookup table or a `CHECK` constraint.

### Enum changes

- `ALTER TYPE ... ADD VALUE` on PG12+: instant; EXCLUSIVE lock on the type object only (not the table). Safe.
- `ALTER TYPE ... ADD VALUE` on PG<12: SHARE UPDATE EXCLUSIVE and inside-transaction restrictions. Migrate to PG12+ before using.
- `ALTER TYPE ... DROP VALUE`: does not exist in Postgres. Plan accordingly.

### Partitioning

- `ATTACH PARTITION` on PG12+: SHARE UPDATE EXCLUSIVE on the parent (does not block reads on parent or sibling partitions). PG<12: ACCESS EXCLUSIVE on parent.
- `DETACH PARTITION CONCURRENTLY` (PG14+): SHARE UPDATE EXCLUSIVE. Safe.
- `DETACH PARTITION` (blocking): ACCESS EXCLUSIVE.

### Refresh materialized view

- `REFRESH MATERIALIZED VIEW CONCURRENTLY`: EXCLUSIVE lock on the matview. Allows reads, blocks writes. Requires a unique index on the matview.
- `REFRESH MATERIALIZED VIEW` (non-concurrent): ACCESS EXCLUSIVE. Blocks reads and writes.

### Destructive

- `DROP TABLE`, `TRUNCATE`: CRITICAL, ACCESS EXCLUSIVE. Schedule a separate release.
- `DELETE ... WHERE TRUE` (or no WHERE): writes a row version for every row, ROW EXCLUSIVE, but generates massive WAL. Batch instead.
- `DROP COLUMN`: ACCESS EXCLUSIVE. The column data is not actually removed; the column is just hidden. Reads and writes block while metadata updates.

## Safe rewrite patterns (memorize these)

### Add a NOT NULL column with a default

```sql
-- Migration 1: nullable, fast metadata-only on PG11+
ALTER TABLE t ADD COLUMN IF NOT EXISTS col text;

-- Migration 2: batched backfill (separate file, no transaction wrapper)
DO $$
DECLARE updated int := 1;
BEGIN
  WHILE updated > 0 LOOP
    WITH batch AS (
      SELECT ctid FROM t
      WHERE col IS NULL
      LIMIT 1000
      FOR UPDATE SKIP LOCKED
    )
    UPDATE t SET col = '<default>'
    FROM batch
    WHERE t.ctid = batch.ctid;
    GET DIAGNOSTICS updated = ROW_COUNT;
  END LOOP;
END $$;

-- Migration 3: validated NOT NULL
ALTER TABLE t ADD CONSTRAINT t_col_nn CHECK (col IS NOT NULL) NOT VALID;
ALTER TABLE t VALIDATE CONSTRAINT t_col_nn;
ALTER TABLE t ALTER COLUMN col SET NOT NULL;
ALTER TABLE t DROP CONSTRAINT t_col_nn;
```

### Add a foreign key

```sql
ALTER TABLE child ADD CONSTRAINT fk_child_parent
  FOREIGN KEY (parent_id) REFERENCES parent (id) NOT VALID;
ALTER TABLE child VALIDATE CONSTRAINT fk_child_parent;
```

### Add a unique constraint

```sql
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS uq_t_col ON t (col);
ALTER TABLE t ADD CONSTRAINT uq_t_col UNIQUE USING INDEX uq_t_col;
```

### Change a column type (when narrowing)

```sql
-- Not actually safe to do in one step. The shape:
-- 1. Add new column of the target type
-- 2. Backfill: UPDATE t SET new_col = cast(old_col AS new_type) WHERE new_col IS NULL
-- 3. Make new column NOT NULL via the safe pattern above
-- 4. Update application reads to use new_col, writes to write both
-- 5. Stop writing old_col, then DROP it
-- See: https://pgfence.com/docs/recipes/alter-column-type
```

### Create an index

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_t_col ON t (col);
```

Run outside any transaction wrapper.

## Tools

- CLI: `pgfence analyze migrations/*.sql`
- Explainer: `pgfence explain "ALTER TABLE t ADD COLUMN x int NOT NULL"`
- GitHub Action: see https://github.com/flvmnt/pgfence
- VS Code extension: `flvmnt.pgfence` on the Marketplace
- LSP server: `pgfence lsp` (stdio)

## When in doubt

`pgfence explain "<your statement>"` returns the lock mode, what it blocks, and
the safe rewrite recipe.
