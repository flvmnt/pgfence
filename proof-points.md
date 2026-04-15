# Proof Points

This page separates repo-backed proof from external references. If a product claim is not tied to code, tests, or changelog entries here, treat it as roadmap, opinion, or an external reference that needs its own citation.

## Repo-Backed Today

| Claim | Evidence | What It Proves |
|---|---|---|
| Prisma support exists | [`src/extractors/prisma.ts`](src/extractors/prisma.ts), [`tests/extractors.test.ts`](tests/extractors.test.ts), [`tests/analyzer.test.ts`](tests/analyzer.test.ts) | Prisma is a real supported format, not just a README mention |
| TypeORM support exists | [`src/extractors/typeorm.ts`](src/extractors/typeorm.ts), [`tests/extractors.test.ts`](tests/extractors.test.ts), [`tests/analyzer.test.ts`](tests/analyzer.test.ts) | TypeORM is a real supported format, not just listed in docs |
| Knex support exists | [`src/extractors/knex.ts`](src/extractors/knex.ts), [`tests/extractors.test.ts`](tests/extractors.test.ts), [`tests/analyzer.test.ts`](tests/analyzer.test.ts) | Knex is a real supported format, including builder extraction and dynamic-SQL warnings |
| Drizzle support exists | [`src/extractors/drizzle.ts`](src/extractors/drizzle.ts), [`tests/extractors.test.ts`](tests/extractors.test.ts) | Drizzle is a real supported format in the analyzer path |
| Sequelize support exists | [`src/extractors/sequelize.ts`](src/extractors/sequelize.ts), [`tests/extractors.test.ts`](tests/extractors.test.ts), [`tests/analyzer.test.ts`](tests/analyzer.test.ts) | Sequelize is a real supported format, including warnings for unanalyzable SQL |
| GitLab Code Quality output exists, and coverage stays visible | [`src/reporters/gitlab.ts`](src/reporters/gitlab.ts), [`tests/reporters.test.ts`](tests/reporters.test.ts) | GitLab output is shipped, repeated findings stay distinct, extraction warnings are preserved, and a coverage summary entry is emitted |
| LSP packaging is import-safe | [`package.json`](package.json), [`src/index.ts`](src/index.ts), [`tests/reporters.test.ts`](tests/reporters.test.ts) | `pgfence-lsp` is the standalone server binary, while the `./lsp` subpath resolves without auto-starting the server |
| Major shipped surfaces are documented in the changelog | [`CHANGELOG.md`](CHANGELOG.md) | The changelog records shipped LSP, trace mode, GitHub PR comments, and SARIF support |
| The repo has an explicit migration-safety narrative | [`README.md`](README.md) | The product is positioned as migration safety and safe rewrites, not a generic SQL linter |

## Claims We Should Keep Narrow

- We should not claim public customer logos, testimonials, or design partners unless we can link to them.
- We should not claim adoption numbers, search ranking, or stars unless the number is current and visible in a public source.
- We should not claim benchmark superiority unless we publish the benchmark and the method.
- We should not claim security audits, compliance certifications, or enterprise readiness unless those artifacts exist publicly.

## External References, Not Repo Proof

- [pglt Related Work](https://github.com/supabase-community/postgres-language-server/blob/main/docs/reference/related_work.md)
- [Prisma integration guide](https://www.prisma.io/docs/guides/integrations/pgfence)

## Repo Sources Worth Linking

- [`CHANGELOG.md`](CHANGELOG.md)
- [`README.md`](README.md)
- [`src/extractors/prisma.ts`](src/extractors/prisma.ts)
- [`src/extractors/typeorm.ts`](src/extractors/typeorm.ts)
- [`src/extractors/knex.ts`](src/extractors/knex.ts)
- [`src/extractors/drizzle.ts`](src/extractors/drizzle.ts)
- [`src/extractors/sequelize.ts`](src/extractors/sequelize.ts)
- [`src/reporters/gitlab.ts`](src/reporters/gitlab.ts)
- [`tests/extractors.test.ts`](tests/extractors.test.ts)
- [`tests/reporters.test.ts`](tests/reporters.test.ts)

## Practical Reading Order

1. Start with `README.md` for the positioning.
2. Check `proof-points.md` for repo-backed proof and clearly labeled external references.
3. Use the linked source files when someone asks, “Can we prove that from the repo?”
