---
name: 🧩 Unsupported ORM pattern
about: pgfence could not analyze a migration written through TypeORM / Prisma / Knex / Sequelize / Drizzle.
title: 'Unsupported ORM pattern: '
labels: 'enhancement, extractor'
assignees: ''
---

## ORM and pattern

Which ORM, and what pattern is pgfence not handling?

- ORM: <!-- TypeORM / Prisma / Knex / Sequelize / Drizzle -->
- Pattern (one line):

## Migration source

Paste the migration source. The smaller the repro the better, ideally just the migration class / function pgfence cannot analyze.

```ts

```

## What pgfence does today

Paste the relevant pgfence output. Look especially for `ExtractionWarning` entries and the coverage line: pgfence should never silently skip a statement; it should emit a warning and count it as unanalyzable.

```

```

## What should happen

What should pgfence do with this pattern?

- Extract / transpile it to SQL and analyze normally
- Emit a more specific `ExtractionWarning` that names the pattern
- Document it as a known limitation
- Other:

## Environment

- pgfence version: <!-- e.g. 0.5.1 -->
- CLI invocation: <!-- e.g. `pgfence analyze --format knex migrations/*.ts` -->
- ORM version: <!-- e.g. TypeORM 0.3.20, Knex 3.1.0 -->

## Anything else?

Optional. Link to ORM docs for the pattern, or a snippet showing how the pattern compiles to SQL when run.
