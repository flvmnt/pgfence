# Proof Points

This page keeps the public claims in pgfence honest. If a claim is not listed here, treat it as roadmap or opinion, not proof.

## What We Can Substantiate Today

| Claim | Evidence | What It Proves |
|---|---|---|
| Prisma support exists | [`src/extractors/prisma.ts`](src/extractors/prisma.ts), [`tests/extractors.test.ts`](tests/extractors.test.ts), [`tests/analyzer.test.ts`](tests/analyzer.test.ts) | Prisma is a real supported format, not just a README mention |
| Prisma documents pgfence publicly | [Prisma integration guide](https://www.prisma.io/docs/guides/integrations/pgfence) | pgfence is visible in the Prisma ecosystem, not just in our own repo |
| TypeORM, Knex, Drizzle, and Sequelize support exist | [`src/extractors/`](src/extractors) and format tests throughout `tests/` | ORM analysis is a real code path with coverage |
| Related-work inclusion is public | [pglt Related Work](https://github.com/supabase-community/postgres-language-server/blob/main/docs/reference/related_work.md) | pgfence is publicly listed alongside Eugene, Squawk, Strong Migrations, and pgroll |
| Major product surfaces are public | [`CHANGELOG.md`](CHANGELOG.md) | Trace mode, GitHub PR comments, SARIF, LSP, GitLab Code Quality, and trust-contract fixes are all documented as shipped |
| The repo has an explicit migration-safety narrative | [`README.md`](README.md), [`website/src/pages/docs/introduction.astro`](website/src/pages/docs/introduction.astro) | The product is positioned as migration safety plus governance, not a generic SQL linter |

## Claims We Should Keep Narrow

- We should not claim public customer logos, testimonials, or design partners unless we can link to them.
- We should not claim adoption numbers, search ranking, or stars unless the number is current and visible in a public source.
- We should not claim benchmark superiority unless we publish the benchmark and the method.
- We should not claim security audits, compliance certifications, or enterprise readiness unless those artifacts exist publicly.

## Public Proof Sources Worth Linking

- [pglt Related Work](https://github.com/supabase-community/postgres-language-server/blob/main/docs/reference/related_work.md)
- [Prisma integration guide](https://www.prisma.io/docs/guides/integrations/pgfence)
- [`CHANGELOG.md`](CHANGELOG.md)
- [`README.md`](README.md)
- [`src/extractors/prisma.ts`](src/extractors/prisma.ts)
- [`tests/extractors.test.ts`](tests/extractors.test.ts)

## Practical Reading Order

1. Start with `README.md` for the positioning.
2. Check `proof-points.md` for substantiated claims.
3. Use the linked source files when someone asks, “Can we prove that?”
