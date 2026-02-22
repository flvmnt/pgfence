import CodeBlock from '../components/CodeBlock';

export default function QuickStart() {
  return (
    <>
      <h1>Quick Start</h1>
      <p className="doc-lead">Analyze your first migration in under a minute.</p>

      <h2 id="analyze-a-file">Analyze a File</h2>
      <CodeBlock language="bash" code={`pgfence analyze migrations/add-email-verified.sql`} />

      <h2 id="example-output">Example Output</h2>
      <CodeBlock language="bash" code={`migrations/add-email-verified.sql  [HIGH]
  Lock: ACCESS EXCLUSIVE | Blocks: reads+writes+DDL | Risk: HIGH | Rule: add-column-not-null-no-default

┌────┬──────────────────────────────────────────────┬────────────────────┬────────────────┬────────────┬──────────────────────────────────────────────┐
│ #  │ Statement                                    │ Lock Mode          │ Blocks         │ Risk       │ Message                                      │
├────┼──────────────────────────────────────────────┼────────────────────┼────────────────┼────────────┼──────────────────────────────────────────────┤
│ 1  │ ALTER TABLE users ADD COLUMN email_verified  │ ACCESS EXCLUSIVE   │ reads, writes, │ HIGH       │ ADD COLUMN "email_verified" with NOT NULL    │
│    │ BOOLEAN NOT NULL                             │                    │ DDL            │            │ but no DEFAULT...                            │
└────┴──────────────────────────────────────────────┴────────────────────┴────────────────┴────────────┴──────────────────────────────────────────────┘

  Policy Violations:
  ERROR Missing SET lock_timeout
    → Add SET lock_timeout = '2s'; at the start of the migration

  Safe Rewrite Recipes:

  add-column-not-null-no-default: Add nullable column, backfill, then add NOT NULL constraint
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean;
    -- Backfill out-of-band in batches (repeat until 0 rows updated)...
    ALTER TABLE users ADD CONSTRAINT chk_nn CHECK (email_verified IS NOT NULL) NOT VALID;
    ALTER TABLE users VALIDATE CONSTRAINT chk_nn;
    ALTER TABLE users ALTER COLUMN email_verified SET NOT NULL;
    ALTER TABLE users DROP CONSTRAINT chk_nn;

=== Coverage ===
Postgres ruleset: PG11+ (configurable)
Analyzed: 1 statements  |  Unanalyzable: 0  |  Coverage: 100%`} />

      <h2 id="analyze-orm-migrations">Analyze ORM Migrations</h2>
      <CodeBlock language="bash" code={`# TypeORM
pgfence analyze --format typeorm src/migrations/*.ts

# Prisma
pgfence analyze --format prisma prisma/migrations/**/migration.sql

# Knex
pgfence analyze --format knex migrations/*.ts

# Auto-detect format
pgfence analyze migrations/*`} />

      <h2 id="ci-integration">CI Integration</h2>
      <CodeBlock language="yaml" code={`- name: Check migration safety
  uses: flvmnt/pgfence@v1
  with:
    path: migrations/*.sql
    max-risk: medium`} />
    </>
  );
}
