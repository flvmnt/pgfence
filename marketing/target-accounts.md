# pgfence Target Accounts

*Last updated: April 15, 2026*

This list is for founder-led outbound, not broad top-of-funnel marketing. Every account below has a public signal that maps cleanly to pgfence's wedge:

- Postgres in production
- TypeScript or Node-heavy backend work
- visible ORM or migration usage
- enough engineering complexity that migration review can break down

## Best First Segment

Start with companies that look like this:

- 20 to 200 engineers
- Postgres in production
- TypeScript, Node.js, or full-stack React plus Node
- Prisma, TypeORM, Sequelize, or other visible ORM usage
- active hiring, platform work, or product growth

Why this segment first:

- The pain is legible from public signals
- The buyer can understand the value in one email
- The wedge is narrow and operationally expensive when it breaks
- Teams are often too small for heavy DBA process and too large for ad hoc review

## Wave 1: Highest-Fit Accounts

| Company | Public signal | Why it fits pgfence | Likely buyer | Source |
|---|---|---|---|---|
| Grid | Senior Backend Engineer role lists NestJS, TypeScript, PostgreSQL, and TypeORM in the stack | Very clear TypeORM plus Postgres story, backend-heavy, likely frequent schema changes | Head of Engineering, Staff Engineer, Platform Lead | [Grid job post](https://jobs.ashbyhq.com/gridverify/b9760884-8aac-4f76-9922-0ce8c048bb63) |
| Solace | Senior Full Stack Engineer role lists TypeScript across applications, NestJS API with TypeORM, and Postgres | Strong TypeORM plus Postgres signal in a fast-growing product team | Head of Engineering, Engineering Manager, Staff Engineer | [Solace job post](https://jobs.ashbyhq.com/solace/19759414-954f-48f7-a8d8-aaf1ae195122) |
| Toma | Senior or Staff role lists T3 Stack, Next.js, React, Prisma, PostgreSQL, NextAuth, and tRPC | Clear Prisma plus Postgres signal, small enough for direct founder or engineering-lead outreach | CTO, Head of Engineering, Staff Engineer | [Toma job post](https://jobs.ashbyhq.com/toma/b4cea507-8397-490a-9f68-da1795fc2c49) |
| Jolly | Software Engineer role lists TypeScript, React, Node.js, PostgreSQL, and ORMs such as Prisma or Sequelize | Full-stack product team with explicit ORM plus Postgres usage and CI/CD | CTO, Engineering Manager, Senior Staff Engineer | [Jolly job post](https://jobs.ashbyhq.com/jolly/86d0edf6-20d2-4bd8-bcf1-8be33c46bc50) |
| Ketryx | Full Stack role lists PostgreSQL, Redis, GraphQL, Prisma, AWS, and regulated-industry experience | Regulated software makes migration review more likely to become a governance buy | CTO, Head of Platform, Engineering Manager | [Ketryx job post](https://job-boards.greenhouse.io/ketryx/jobs/4408592008) |
| WPP Media | Senior Full-Stack role lists Node.js, NestJS, Prisma, PostgreSQL, and GitLab CI/CD | Large operational surface with explicit Prisma plus Postgres and deployment discipline | Director of Engineering, Platform Lead, Senior Manager | [WPP Media job post](https://job-boards.greenhouse.io/wppmedia/jobs/5152959008) |
| SewerAI | Senior Staff role lists Node.js or TypeScript, PostgreSQL or PostGIS, Prisma ORM, schema management and migrations, and CI/CD | Explicit schema management and migration pain in a growing product team | VP Engineering, Staff Engineer, Platform Lead | [SewerAI job post](https://jobs.ashbyhq.com/sewer-ai/de5d3697-54be-4e57-8d9e-999f0ab4494d/) |
| Cal.com | Contributor guide says the product is built on Next.js, TypeScript, PostgreSQL, and Prisma | Public OSS product with visible Prisma usage and likely steady schema churn | CTO, Platform Lead, Engineering Manager | [Cal.com contributor guide](https://cal.com/docs/developing/open-source-contribution/contributors-guide) |
| Trigger.dev | Public docs include a Prisma setup guide for Trigger.dev workflows | Developer-tool company with direct Prisma usage, and an easy technical conversation starter around migration review | Founder, CTO, Head of Engineering | [Trigger.dev Prisma guide](https://trigger.dev/docs/guides/frameworks/prisma) |
| Peec AI | Senior Fullstack role lists TypeScript and PostgreSQL in the production stack | Weaker ORM signal than others, but still a useful TypeScript plus Postgres account in a growing team | CTO, Head of Engineering, Senior Engineer | [Peec AI job post](https://jobs.ashbyhq.com/peec/4c12e247-74c3-47e2-b15c-f7686bf3b887) |

## Why These 10 First

This wave gives you:

- 3 TypeORM-heavy accounts: Grid, Solace, Jolly
- 4 Prisma-heavy accounts: Toma, Ketryx, Cal.com, Trigger.dev
- 2 broader Postgres plus Prisma or ops accounts: WPP Media, SewerAI
- 1 lighter fallback account: Peec AI

That mix is good enough to learn which signal gets replies fastest without spraying too many variants at once.

## Buyer Priority

Start with these titles:

- Head of Engineering
- Engineering Manager, backend or platform
- Staff or Principal Engineer
- CTO, if the team still looks small

Avoid starting with:

- recruiters
- generic contact inboxes
- junior ICs

## Personalization Angles By Signal

- Prisma: "Saw the team is using Prisma with Postgres. I was curious how rollout safety gets reviewed today, beyond SQL correctness."
- TypeORM: "TypeORM makes it easy to ship migrations, but it still leaves the lock-risk question to memory and manual review."
- Regulated product: "If the team already needs tighter process around software changes, risky schema changes are usually part of that control gap."
- Platform and CI/CD signal: "Once teams formalize delivery and reliability, migration safety tends to become one of the recurring hidden failure modes."
- OSS or devtools: "You already have public docs and a technical audience, which usually means migration sharp edges show up faster and more visibly."

## Proof Points To Use In Replies

Use these only after interest, or when someone asks why they should trust the tool.

- Prisma has a public integration guide for pgfence: [Prisma integration guide](https://www.prisma.io/docs/guides/integrations/pgfence)
- pglt lists pgfence in its migration-safety related work: [pglt related work](https://raw.githubusercontent.com/supabase-community/postgres-language-server/main/docs/reference/related_work.md)
- The repo proof trail for ORM support and shipped surfaces lives here: [proof-points.md](../proof-points.md)

## Recommended Sending Order

1. Grid
2. Solace
3. Toma
4. Jolly
5. Ketryx
6. SewerAI
7. WPP Media
8. Cal.com
9. Trigger.dev
10. Peec AI

## How To Work The List

1. Send the first 10 emails over 3 to 4 days.
2. Log replies by signal type, Prisma, TypeORM, regulated, or generic Postgres.
3. If one signal gets real replies, build the next 20 around that stack.
4. Keep the ask to a 15 minute compare-notes call, not a product demo.
