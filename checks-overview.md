# Checks Overview

This tracked reference keeps the shipped open-source rule families easy to audit in public CI. It is intentionally narrow: every section below maps to a rule family that exists in `src/rules/` today.

## Lock And Safety Rule Families

### ADD COLUMN checks

`ADD COLUMN checks` cover the common footguns around `NOT NULL`, generated columns, volatile defaults, and metadata-only cases that are safe on modern PostgreSQL versions.

### ADD CONSTRAINT checks

`ADD CONSTRAINT checks` cover foreign keys, unique constraints, check constraints, exclusion constraints, primary key rewrites, `NOT VALID`, and `VALIDATE CONSTRAINT` rollouts.

### ALTER COLUMN checks

`ALTER COLUMN checks` cover type changes, `SET NOT NULL`, `DROP NOT NULL`, `SET DEFAULT`, and cases where schema snapshots can turn a heuristic warning into a more definitive result.

### ALTER TYPE ... ADD VALUE (enum)

`ALTER TYPE ... ADD VALUE (enum)` covers PostgreSQL enum changes, including transaction restrictions and the safer expectations on PostgreSQL 12 and newer.

### Data type best practices

`Data type best practices` flag choices that are legal SQL but usually a bad default for long-lived production schemas, such as `MONEY`, `SERIAL`, and overly broad `VARCHAR(n)` usage where a more robust type or constraint strategy is clearer.

### CREATE INDEX / DROP INDEX checks

`CREATE INDEX / DROP INDEX checks` cover blocking index builds, concurrent index operations, and transaction constraints around `CONCURRENTLY`.

### Destructive operation checks

`Destructive operation checks` cover `DROP TABLE`, `DROP SCHEMA`, `DROP COLUMN`, `TRUNCATE`, dangerous `DELETE`, and similar operations where the migration is intentionally destructive or easy to misuse.

### Partition operations (ATTACH/DETACH)

`Partition operations (ATTACH/DETACH)` cover attach and detach operations, including the concurrency differences that matter on PostgreSQL 14 and newer.

### Prefer robust DDL statements

`Prefer robust DDL statements` nudges migrations toward more defensive, repeatable statements such as `IF EXISTS`, `IF NOT EXISTS`, and other variants that reduce rollout fragility across environments.

### REFRESH MATERIALIZED VIEW

`REFRESH MATERIALIZED VIEW` covers blocking refreshes, concurrent refresh behavior, and the unique-index prerequisite for `CONCURRENTLY`.

### REINDEX (non-concurrent)

`REINDEX (non-concurrent)` covers the lock impact of table, index, schema, and database reindex operations, along with the safer concurrent alternatives where PostgreSQL supports them.

### RENAME checks

`RENAME checks` cover column, table, and schema rename operations, including version-sensitive guidance where a rename is instant but still disruptive at the application layer.

### Trigger operations

`Trigger operations` cover trigger creation, replacement, enable or disable flows, and the lock implications around modifying trigger state on a live table.

## Policy Checks

Policy checks live alongside the rule families above and enforce migration guardrails that are easy to forget in review:

- `SET lock_timeout`
- `SET statement_timeout`
- `SET application_name`
- `SET idle_in_transaction_session_timeout`
- `CONCURRENTLY` outside explicit transactions
- ordering checks, like setting `lock_timeout` before dangerous DDL

## Where To Go Next

- Start with [`README.md`](README.md) for installation, usage, and the full risk matrix.
- Use [`examples/pr-review-demo`](examples/pr-review-demo/README.md) for a realistic risky migration, generated review artifacts, and the safer rollout that should merge instead.
- Use [`proof-points.md`](proof-points.md) when you need repo-backed evidence for support claims.
