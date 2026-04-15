# pgfence Cloud Outreach Pack

*Last updated: April 15, 2026*

## Use This Angle

Lead with a short, specific note about the public stack signal, then offer a design-partner conversation for the planned pgfence Cloud layer. Keep the analyzer free, and position the design-partner program around approvals, policy, and audit history for risky Postgres migrations.

## Proof You Can Use

Do not front-load these in the first email. Use them in replies, follow-ups, or live calls.

- Prisma has a public pgfence integration guide: [Prisma integration guide](https://www.prisma.io/docs/guides/integrations/pgfence)
- pglt lists pgfence in its migration-safety related work: [pglt related work](https://raw.githubusercontent.com/supabase-community/postgres-language-server/main/docs/reference/related_work.md)
- Repo-backed proof for ORM support and shipped surfaces lives here: [proof-points.md](../proof-points.md)

## Best Current Signals

The highest-signal outbound targets right now are the companies in [target-accounts.md](./target-accounts.md), especially those with public TypeORM or Prisma plus Postgres evidence.

Current best first wave:

- Grid
- Solace
- Toma
- Jolly
- Ketryx
- WPP Media
- SewerAI
- Cal.com
- Trigger.dev
- Peec AI

## Cold Email 1

**Subject:** Quick question about Postgres migration safety at {{company}}

Hi {{first_name}},

I saw {{signal}} and thought it might be worth reaching out.

pgfence helps teams catch risky Postgres migrations before merge. I’m also working with a small number of teams on a design-partner program for approvals, policy enforcement, and audit history when changes need more control.

If {{company}} is doing a lot of schema work in Postgres, especially through Prisma, TypeORM, Knex, Sequelize, or Drizzle, I would be happy to show you how we catch lock-heavy changes and surface safe rewrites early.

Would you be open to a 15 minute design partner conversation?

Best,
{{sender_name}}

## Cold Email 2

**Subject:** Design partner invite for pgfence Cloud

Hi {{first_name}},

We are looking for a small number of design partners for the planned pgfence Cloud layer.

The free CLI stays free. The design-partner program is for teams that want to shape approvals, exemptions, and an audit trail around dangerous Postgres migrations.

Based on {{signal}}, I think {{company}} may be a good fit if your team wants fewer review misses without forcing everyone into a heavyweight DBA process.

If useful, I can walk you through the design partner offer and show a real migration example on a call.

Thanks,
{{sender_name}}

## Cold Email 3

**Subject:** Could pgfence help with migration reviews?

Hi {{first_name}},

I am reaching out because {{signal}} suggests your team is probably shipping schema changes often.

pgfence is built for exactly that moment, when the migration is technically valid but still risky enough to deserve a better review path. We show lock mode, blast radius, and safe alternatives today, and the design-partner program is about whether a governance layer would help leaders enforce the rules consistently.

If migration risk is a real operational concern at {{company}}, I would love to compare notes and see whether a design partner pilot makes sense.

Best,
{{sender_name}}

## Follow-Up 1

**Subject:** Re: {{company}} and Postgres migration risk

Hi {{first_name}},

Just bumping this in case it got buried.

If you are still open to design partner conversations, I can keep it simple: one call, one real migration, and a quick look at whether pgfence would save your team time or reduce risk.

Want me to send a few times?

## Follow-Up 2

**Subject:** Worth a quick look?

Hi {{first_name}},

Last note from me.

If pgfence is not relevant, no worries. If you are planning any Postgres schema work this quarter, I think the lock visibility plus governance layer could be useful.

If it helps, reply with the migration stack you use and I will send a tighter example.

## LinkedIn DM

Hi {{first_name}}, I saw {{signal}} and thought pgfence might be relevant. We help teams review Postgres migrations before merge today, and I’m speaking with a few teams about a design-partner program for approvals and audit history around the risky changes. If you are open to a design partner chat, I would be glad to share the shortest path to value.

## Notes

- Keep the first message short and personal.
- Mention one public signal only.
- Ask for a conversation, not a demo.
- If they reply with a stack detail, mirror their wording in the next message.
