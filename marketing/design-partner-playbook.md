# pgfence Design Partner Playbook

*Last updated: April 15, 2026*

## Goal

Get the first 3 to 5 paid design partners for pgfence Cloud without relying on broad brand awareness.

The goal is not mass demand. The goal is:

- 30 targeted conversations
- 10 qualified discovery calls
- 3 serious pilots
- 1 to 3 paid annual or pilot commitments

## Core Positioning

### What you are selling

Do not sell “a migration linter.”

Sell this:

> pgfence helps engineering teams prevent Postgres migration incidents and adds governance for risky schema changes.

### Paid promise

> The analyzer stays free. pgfence Cloud gives engineering leaders approvals, policy enforcement, and audit history for risky Postgres migrations.

### Best-fit ICP

Prioritize teams that look like this:

- 10 to 100 engineers
- Postgres in production
- Node or TypeScript-heavy stack
- Prisma, TypeORM, Knex, Sequelize, Drizzle, or raw SQL migrations
- No dedicated DBA in every review loop
- Fast shipping cadence
- Recent reliability pain, or compliance pressure

### Best first segment

Start with product teams that already show public TypeScript or Node usage plus Postgres and Prisma or Drizzle in docs or hiring. The easiest early wins are design-partner friendly SaaS, fintech, workflow, and developer-tool companies with active migration churn and a small group of engineering leaders who can say yes quickly.

### Who to target first

- Head of Engineering
- Engineering Manager
- Staff / Platform Engineer
- CTO at smaller teams

## Your Best Channels

If nobody knows the product yet, do not start with broad paid acquisition.

Start with these channels in order:

### 1. Founder-led outbound

This is the fastest path to first revenue.

Why it fits:

- You do not need a big audience
- The pain is high-value and specific
- The buyer list is easy to define
- The product category is early, so direct education matters

How to start:

- Build a list of 100 target companies
- Prioritize teams hiring for platform, infra, backend, or database-heavy roles
- Look for public stack clues: TypeORM, Prisma, Knex, Sequelize, Postgres, migrations
- Send short, specific outreach from your own account

### 2. Problem-led founder content on LinkedIn and X

This is your credibility engine, not your primary conversion engine.

Why it fits:

- Buyers are reachable there
- You can build trust with real migration stories and code examples
- LinkedIn is pushing video harder in 2025, so short clips are more viable than they were before

How to start:

- Post 3 times per week on LinkedIn
- Cross-post to X
- Mix text posts, screenshots, terminal demos, and short clips

### 3. SEO content around painful migration scenarios

This is a medium-term demand capture channel.

Why it fits:

- Buyers search for specific incidents, not category labels
- You already have strong technical material and comparison angles

Best topics:

- “ALTER TABLE ADD COLUMN NOT NULL Postgres lock”
- “TypeORM migration took down production”
- “CREATE INDEX CONCURRENTLY inside transaction”
- “Postgres migration lock_timeout”
- “[competitor] vs pgfence”

### 4. Community distribution

Use this for awareness and credibility, not spam.

Places to test:

- Hacker News launch/update posts when you have a strong story
- relevant Reddit threads where migration pain is already being discussed
- Postgres and ORM-specific communities
- GitHub discussions, issue threads, and comparison conversations

Rule:

- Teach first
- Never lead with “buy my tool”

### 5. Engineering-as-marketing

This is likely your best scalable long-term channel after outbound.

Best fit free tools:

- Postgres lock mode explainer
- migration risk checker
- safe rewrite generator for common migration patterns
- “will this migration block reads?” interactive checker

Rule from Heavybit-style devtool distribution:

- no signup
- one job
- free

## Should You Make Reels?

Yes, but not as the main plan.

The right answer is:

- do not bet the company on Instagram or TikTok-style reels
- do make short video clips for LinkedIn and X
- repurpose them from blog posts, demos, and incident explainers

Why:

- LinkedIn says video is one of its fastest-growing formats, and its 2025 B2B video report says video engagement growth is outpacing other formats on the platform. [LinkedIn product news](https://news.linkedin.com/2025/helping-brands-expand-their-reach-in-new-ways-with-video-from-to) [LinkedIn video report](https://business.linkedin.com/content/dam/business/marketing-solutions/global/en_US/site/pdf/wp/2025/the-art-and-science-of-video.pdf)
- But early-stage devtools still win faster with targeted outbound, useful content, and free tools than with broad creator-style social.

Use video like this:

- 2 short clips per week
- 30 to 60 seconds each
- subtitles on
- terminal or editor on screen
- one idea per clip

Good video topics:

- “This migration blocks every read and write, here’s why”
- “The TypeORM migration footgun that pages teams at 2 AM”
- “How to add a foreign key without locking production”
- “Why `SET lock_timeout` belongs in every migration”

## 30-Day Plan

### Week 1

- Finalize the design partner offer
- Update homepage, pricing, and cloud page to sell the design partner program
- Create a target account list of 100 companies
- Publish 2 strong founder posts

### Week 2

- Start outbound to 15 to 20 prospects per day
- Publish 1 blog post on a painful migration footgun
- Post 1 short terminal demo clip
- Collect objections and refine the pitch

### Week 3

- Run discovery calls
- Convert the best conversations into a structured beta offer
- Publish one comparison page and one incident story
- Start direct asks for referrals and intros

### Week 4

- Close 1 to 3 design partner agreements
- Turn common objections into FAQ and site copy
- Package the strongest screenshot, quote, or use case into proof
- Decide whether to keep manual sales or add a waitlist/demo funnel

## Design Partner Offer

### Offer structure

Call it:

**pgfence Cloud Design Partner Program**

What they get:

- early access to approvals, policy management, audit trail, and exemption workflows
- direct founder support
- faster feature feedback loop
- discounted pricing in exchange for feedback and references if successful

How to sell it:

- 3-month paid pilot
- or discounted first-year annual contract

Suggested range:

- pilot: `$1,500 to $4,000` total
- annual design partner: `$6,000 to $15,000 ARR`

Choose based on company size and urgency.

## Outbound Prospecting

### What to look for

- Postgres job postings
- platform engineering hiring
- public engineering blogs mentioning Prisma, TypeORM, Knex, Sequelize
- teams shipping frequently
- companies where reliability matters

### Good trigger signals

- recent infrastructure hiring
- recent incident or postmortem culture
- launch of a new product line with likely schema churn
- public stack migration or data-platform changes

See [target-accounts.md](target-accounts.md) for the live account list and [outreach-sequences.md](outreach-sequences.md) for the current email and DM copy.

## Outreach Templates

### Cold email 1

Subject: migration review

Hi {{first_name}},

Saw that your team is shipping on Postgres with {{stack_or_signal}}.

I’m working on pgfence, a migration safety tool that shows what a schema change actually locks before it hits prod, then adds approvals and audit history for risky changes.

Reaching out because teams usually look at this after one painful migration blocks reads or writes in production.

Worth a look if this is a problem you’ve felt already?

Flavius

### Cold email 2

Subject: postgres footguns

Hi {{first_name}},

Quick one: are migrations reviewed for lock impact on your team, or mostly for SQL correctness?

I’m building pgfence for teams using Postgres with ORMs like Prisma, TypeORM, and Knex. It catches lock-heavy changes before merge and is moving toward a cloud layer for approvals and audit history.

If migration safety is on your radar, I’d love to compare notes.

Flavius

### Follow-up

Subject: re: postgres footguns

One example of the problem:

`ALTER TABLE ... ADD COLUMN ... NOT NULL` can look harmless in review and still create a nasty production lock story depending on the pattern.

That gap between “valid SQL” and “safe rollout” is what I’m focused on with pgfence.

Useful to chat, or not a priority right now?

## 20-Minute Discovery Call

### Goal

Do not demo first.

Learn:

- how migrations are reviewed today
- what went wrong in the past
- who owns approval for risky changes
- whether this is painful enough to budget for

### Structure

1. What does migration review look like today?
2. Have you had a migration cause an incident or rollback?
3. Which stacks generate or author migrations?
4. Who is expected to catch dangerous lock behavior?
5. If you could wave a wand, what would the ideal process look like?
6. Would policy, approvals, and auditability matter here, or is this still an individual contributor problem?

## Content Plan

### Weekly content cadence

- 2 LinkedIn posts
- 1 X thread
- 1 short video clip
- 1 comment sprint on relevant discussions

### Best content formats

- migration teardown
- “this SQL looks safe but isn’t”
- lock mode cheat-sheet slices
- ORM footgun examples
- comparison posts against existing tools
- “here is the safe rewrite” posts

### First 10 content ideas

1. The migration that looks safe and still blocks production
2. Why ORMs hide the real Postgres risk
3. The difference between SQL validity and rollout safety
4. Why `CREATE INDEX CONCURRENTLY` still fails in the wrong transaction context
5. How to add a foreign key without blocking writes
6. `lock_timeout` is not optional
7. What engineering managers should require before approving risky migrations
8. Why migration review should be policy-driven, not memory-driven
9. strong_migrations for TypeScript teams, what is missing today
10. The safest way to ship `ALTER COLUMN TYPE`

## Metrics To Watch

- cold email reply rate
- discovery calls booked
- qualified opportunities
- pricing page to contact conversion
- contact form submits
- content impressions from target roles
- demos to pilot conversion

## What To Avoid

- waiting for a large audience before selling
- polishing self-serve billing before closing manual pilots
- trying every social platform at once
- making generic “AI/devtools/startup” content
- spending weeks on brand ads
- hiding the product behind vague platform language

## Recommended Next Build

After the site and outbound foundation, build one free tool that naturally feeds the core product:

- **Migration Lock Checker**

Requirements:

- no signup
- one job
- free
- clear tie to pgfence
- easy to share in posts and docs

This is the highest-leverage marketing asset after outbound.
