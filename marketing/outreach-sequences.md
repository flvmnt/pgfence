# pgfence Outreach Sequences

*Last updated: April 15, 2026*

Use these for direct founder-led outreach to teams with public Postgres + ORM signals.

## Positioning line

pgfence helps engineering teams prevent Postgres migration incidents by showing what a change locks before merge, then adds approvals, policy, and audit history for risky migrations.

## Short call to action

Use one of these:

- Worth a quick compare-notes call?
- Is this a problem you have felt already?
- Open to a short chat if migration review is painful today?

## Cold email 1: Prisma angle

Subject: Prisma migration review

Hi {{first_name}},

Saw that your team is using Prisma with Postgres.

I’m working on pgfence, a migration safety tool that shows what a schema change actually locks before it hits prod, then adds approvals and audit history for risky changes.

Reaching out because teams usually only formalize this after one migration blocks reads or writes in production.

Is this a problem you have felt already, or not really on your radar?

Flavius

## Cold email 2: TypeORM angle

Subject: TypeORM + Postgres

Hi {{first_name}},

Noticed the team is shipping on TypeORM and Postgres.

That stack moves fast, but migration review usually still relies on someone remembering which DDL takes an ugly lock and which one is actually safe.

I’m building pgfence to make that explicit before merge, then layer approvals and audit history on top for the risky cases.

Worth a short compare-notes call if this has been painful on your side?

Flavius

## Cold email 3: engineering-manager angle

Subject: risky migrations

Hi {{first_name}},

Quick question:

How does your team review Postgres migrations today, for rollout safety, not just SQL correctness?

I’m building pgfence around that exact problem. The analyzer stays free, and the paid layer is for approvals, policy, and audit history when teams need more accountable migration review.

Happy to send a short example if useful.

Flavius

## Follow-up 1

Subject: re: risky migrations

One example of the gap:

`ALTER TABLE ... ADD COLUMN ... NOT NULL` can look harmless in review and still create a nasty production lock story depending on the pattern.

That difference between valid SQL and safe rollout is the core problem pgfence is built for.

Useful to compare notes, or not a priority right now?

Flavius

## Follow-up 2

Subject: re: Prisma migration review

Leaving one concrete proof point in case helpful:

- Prisma documents pgfence publicly in its integration guide
- pgfence is also listed in the public pglt related-work page

I’m mostly looking for a few teams who already feel migration-review pain and want to shape the approvals and policy layer with me.

If that is relevant, I’d be glad to talk.

Flavius

## LinkedIn DM

Saw the team is using {{stack_signal}} with Postgres.

I’m working on pgfence, which shows what a migration locks before merge and is growing into a governance layer for risky migrations. Thought it might be relevant if schema review is painful today.

Open to a quick chat?

## Personalization snippets

Use one line, not five.

- "Saw the team is hiring into a NestJS + TypeORM + Postgres stack."
- "Noticed Prisma + PostgreSQL in the job post."
- "The role mentions migrations and schema management explicitly, which is exactly the problem space I work on."
- "You are hiring for platform reliability while running Postgres in production, which usually means migration process starts to matter a lot more."

## Discovery call goal

Do not demo first. Learn:

- how migrations are reviewed today
- where lock-risk knowledge lives
- whether incidents or near-misses have already happened
- whether approvals and auditability would be valuable enough to buy

## Objection handling

| Objection | Short response |
|---|---|
| We review migrations manually already | That is exactly where teams get value first, because pgfence makes the lock impact explicit and consistent. |
| We have not had a migration outage | That is the best time to standardize the process, before the painful one. |
| We already use Prisma / TypeORM / internal review docs | Great, pgfence sits on top of that workflow rather than asking the team to replace it. |
| This feels niche | The scope is narrow, but one blocked production table can create a very expensive day. |

## Sending notes

- Keep the first email under 120 words.
- Use the stack signal in the opener.
- Ask for a conversation, not a sale.
- Send from your real inbox.
- Follow up twice, then move on unless there is engagement.
