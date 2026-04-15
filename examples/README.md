# Examples

These examples are small, copyable demos for docs, testing, and sales conversations.

## Included Examples

- `demo-1-add-column-constant-default.sql`: metadata-only add-column case that is safe on modern PostgreSQL.
- `demo-2-create-index-blocking.sql`: blocking `CREATE INDEX` without `CONCURRENTLY`.
- `demo-3-change-column-type.sql`: `ALTER COLUMN TYPE` lock-heavy example.
- `demo-4-add-foreign-key-blocking.sql`: blocking foreign-key add.
- `demo-5-complex-plpgsql.sql`: unsupported dynamic SQL example.
- `pr-review-demo/`: a polished before-and-after migration review bundle with the risky migration, safe rollout files, and generated reporter artifacts.

## Usage

```bash
pnpm build
node dist/index.js analyze examples/demo-2-create-index-blocking.sql
node dist/index.js analyze --output github examples/pr-review-demo/migrations/20260415_add_last_seen_at.sql
```
