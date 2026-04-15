# PR Review Demo

This bundle mirrors the public docs page at `https://pgfence.com/docs/demo-pr-review`, but keeps the evidence in the repo as real files you can run and inspect.

## Contents

- `migrations/20260415_add_last_seen_at.sql`: the risky migration as it would land in a pull request
- `safe-rollout/`: the safer expand, backfill, contract, and concurrent-index steps
- `artifacts/review-comment.md`: generated GitHub markdown output from the current CLI
- `artifacts/report.json`: generated machine-readable JSON output
- `artifacts/report.sarif`: generated SARIF output for code scanning
- `artifacts/gl-code-quality-report.json`: generated GitLab Code Quality output

## Reproduce

```bash
pnpm build
node dist/index.js analyze --output github examples/pr-review-demo/migrations/20260415_add_last_seen_at.sql > examples/pr-review-demo/artifacts/review-comment.md
node dist/index.js analyze --output json examples/pr-review-demo/migrations/20260415_add_last_seen_at.sql > examples/pr-review-demo/artifacts/report.json
node dist/index.js analyze --output sarif examples/pr-review-demo/migrations/20260415_add_last_seen_at.sql > examples/pr-review-demo/artifacts/report.sarif
node dist/index.js analyze --output gitlab examples/pr-review-demo/migrations/20260415_add_last_seen_at.sql > examples/pr-review-demo/artifacts/gl-code-quality-report.json
```

## What This Shows

The risky migration does three things reviewers routinely miss:

1. It adds a column with `DEFAULT now()`, which is non-constant and can force a table rewrite under an `ACCESS EXCLUSIVE` lock.
2. It makes the column `NOT NULL` immediately, which should be handled in a safer contract step.
3. It creates a plain index without `CONCURRENTLY`, which blocks writes for the duration of the build.

The safe rollout keeps the same product intent but splits it into a production-safer sequence.
