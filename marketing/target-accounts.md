# pgfence Target Accounts

*Last updated: April 15, 2026*

This list is for founder-led outbound, not broad marketing. Every account below has a public signal that maps well to pgfence's design-partner thesis: safer Postgres migrations today, plus a potential governance layer for risky schema changes.

## Best First Segment

Start with companies that look like this:

- 20 to 200 engineers
- TypeScript or Node-heavy backend
- Postgres in production
- Prisma or TypeORM in the stack, because the migration pain is easy to explain
- No obvious DBA-first review process
- Active product or platform hiring, which usually means schema and service churn

Why this segment first:

- The pain is real and technical
- The buyer can understand the product in one email
- Prisma and TypeORM create a clean wedge because pgfence already supports both today
- Teams this size often have reliability pain but still lack formal migration governance

## Priority Accounts

| Company | Public signal | Why it fits pgfence | Likely buyer | Source |
|---|---|---|---|---|
| Solace | TypeScript, NestJS API, TypeORM, Postgres | Clear TypeORM + Postgres stack, active engineering hiring, and a product team that likely ships schema changes fast | Head of Engineering, Staff Engineer, Technical Lead | [Senior Full Stack Engineer](https://jobs.ashbyhq.com/solace/19759414-954f-48f7-a8d8-aaf1ae195122), [Staff Software Engineer](https://jobs.ashbyhq.com/Solace/87748158-42b6-4c55-91ca-8f3d95799ee9) |
| LiteLLM | Postgres, Prisma ORM, Kubernetes, SRE hiring | Infra-aware team with Prisma in production and clear enterprise motion | Founder, Head of Engineering, SRE lead | [Site Reliability Engineer](https://jobs.ashbyhq.com/litellm/f7e671ef-8c36-4e1a-bfce-e7ed79b85c58) |
| Jolly | PostgreSQL plus Prisma or Sequelize | Broad ORM usage suggests schema drift and mixed review habits | CTO, Engineering Manager | [Software Engineer](https://jobs.ashbyhq.com/jolly/86d0edf6-20d2-4bd8-bcf1-8be33c46bc50) |
| Trigger.dev | Public Prisma setup guide and PostgreSQL prerequisite | Developer-tool company with direct Prisma and Postgres use, so the pain is close to the product | Founder, CTO, or Head of Engineering | [Prisma setup guide](https://trigger.dev/docs/guides/frameworks/prisma) |
| Cal.com | Contributor docs say Next.js, TypeScript, PostgreSQL, and Prisma | Open-source product with obvious schema churn and contributor-facing database surface area | CTO, Engineering Lead, Platform Owner | [Contributor's Guide](https://cal.com/docs/developing/open-source-contribution/contributors-guide) |
| Payload | Postgres docs say the adapter leverages Drizzle ORM and `node-postgres`, with migrations called out explicitly | Strong multi-ORM story and a docs-led product that will understand migration correctness quickly | Engineering Lead, Platform Owner | [Postgres docs](https://payloadcms.com/docs/database/postgres) |

## Secondary Accounts

| Company | Public signal | Why it fits pgfence | Likely buyer | Source |
|---|---|---|---|---|
| Parloa | TypeScript and PostgreSQL in customer-facing deployments | Less ORM-explicit, but still a strong Postgres + TypeScript org | Head of Platform, Engineering Manager | [Forward Deployed Engineer](https://boards.greenhouse.io/embed/job_app?for=parloa&token=4656966101) |
| Peec AI | TypeScript plus PostgreSQL in a fast-growth environment | Smaller team, likely easier founder reach, Postgres is explicit in the stack | CTO, Head of Engineering | [Senior Backend Engineer](https://jobs.ashbyhq.com/peec/10403eed-cf80-40fe-b018-2349e9bbe82d) |
| Cygnify | PostgreSQL plus TypeScript or JavaScript in infra-heavy work | Good ops signal, but less direct ORM evidence | Head of Platform, Engineering Manager | [DevOps & Application Engineer](https://jobs.ashbyhq.com/cygnify/03d968f3-edcc-4e53-8b2e-369cb0ef9a1f) |

## Who to contact first inside each account

Start with:

- Head of Engineering
- Engineering Manager for backend or platform
- Staff or Principal Engineer
- CTO, if the company is still small

Avoid starting with:

- Recruiters
- junior ICs
- generic support inboxes

## Personalization angles by stack signal

- Prisma: "Saw the team is using Prisma with Postgres. Curious how migration lock risk gets reviewed today, beyond SQL correctness."
- TypeORM: "TypeORM makes schema changes easy to ship, but not easy to reason about at the lock level. That gap is exactly what I’m working on."
- Sequelize: "Sequelize teams often end up with migrations that are valid SQL but still rough to roll out safely in production."
- Platform or SRE hiring: "When teams start formalizing reliability and review process, migration safety becomes one of those hidden recurring problems."

## Recommended sequence

1. Work the six priority accounts first.
2. Send 15 to 20 targeted emails per day.
3. Reuse the right stack-specific opener from the signal in the source.
4. Track replies by signal type: Prisma, TypeORM, Sequelize, or generic Postgres.
5. After 20 to 30 sends, tighten the copy around the stack that gets the strongest reply rate.
