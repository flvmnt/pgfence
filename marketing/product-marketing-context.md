# Product Marketing Context

*Last updated: April 15, 2026*

## Product Overview
**One-liner:**  
pgfence is a Postgres migration safety CLI, with a planned governance layer, that shows teams what their migrations lock, what they block, and how to ship safer rewrites before production incidents happen.

**What it does:**  
Today, pgfence statically analyzes Postgres migration files and ORM-generated migrations, maps statements to lock modes and risk levels, flags policy problems, and suggests safe expand/contract rewrites. In parallel, the design-partner program is validating a paid governance layer focused on approvals, auditability, and org-wide policy enforcement.

**Product category:**  
Postgres migration safety, migration governance, database change review, developer tooling, DevSecOps for schema changes.

**Product type:**  
Open-source developer tool plus a planned paid B2B governance layer.

**Business model:**  
Free analyzer forever. Planned paid cloud or governance layer, currently being validated with design partners, for approvals, policy management, audit log, and enterprise controls. Best-fit pricing metric is per protected production database or per protected production application.

**Current paid offer:**  
A hands-on paid design-partner pilot for one production Postgres workflow. The buyer is paying for migration governance, rollout help, policy design, and direct support while approvals, exemptions, and auditability are being hardened, not for access to the free analyzer itself.

## Target Audience
**Target companies:**  
Software companies using Postgres in production, typically with 10 to 100 engineers, shipping frequently, and running without a dedicated DBA review process.

**Best first segment:**  
TypeScript or Node-first product teams with Postgres in production and visible migration churn, especially companies already using Prisma, Drizzle, TypeORM, Knex, Sequelize, or raw SQL migrations. Start with design-partner friendly SaaS, fintech, workflow, and developer-tool teams where the buyer can move fast without a committee.

**Decision-makers:**  
Engineering managers, heads of engineering, platform leads, staff engineers, CTOs at smaller teams, and security/compliance stakeholders at more mature companies.

**Primary use case:**  
Catch risky Postgres migrations before merge, and validate whether governance for higher-risk schema changes is valuable enough to buy.

**Jobs to be done:**  
- Prevent migration-induced outages caused by lock-heavy DDL
- Review database changes without needing a deep Postgres expert on every PR
- Validate whether migration safety standards should become a more auditable, policy-driven process across teams

**Use cases:**  
- TypeORM, Prisma, Knex, Sequelize, Drizzle, and raw SQL migration review
- CI checks for migration safety
- Editor diagnostics while writing migrations
- Potential paid use case being validated: approval workflows for HIGH and CRITICAL changes
- Current paid pilot use case: give engineering leaders a more accountable migration review process around one production database or application workflow

## Personas
| Persona | Cares about | Challenge | Value we aim to deliver |
|---------|-------------|-----------|------------------|
| Staff / Platform Engineer | Safe rollout, tooling quality, signal over noise | ORMs and reviewers hide real Postgres lock behavior | Exact lock visibility and safe rewrites before merge |
| Engineering Manager | Reliability, delivery speed, fewer incidents | Schema risk is hard to review consistently across teams | Standardized migration review with enforceable guardrails |
| CTO / VP Engineering | Incident reduction, accountability, platform maturity | One bad migration can create visible downtime and customer pain | Governance and auditability without slowing all developers down |
| Security / Compliance stakeholder | Process integrity, traceability, approvals | Database changes often escape structured controls | Approval records, exemptions, and audit history for risky changes |

## Problems & Pain Points
**Core problem:**  
Application teams ship Postgres migrations without knowing the actual lock impact until production feels it.

**Why alternatives fall short:**  
- ORM generators do not explain Postgres lock semantics
- Manual review depends on rare Postgres specialists
- Generic SQL linters do not understand the real parser, ORM extraction, or safe rewrite sequences
- Runtime tools help after adoption, not before a risky migration is merged

**What it costs them:**  
Downtime, blocked reads and writes, restart storms, rollback fire drills, lost customer trust, and slower releases after painful incidents.

**Emotional tension:**  
Fear of taking production down with a “simple migration,” uncertainty during review, and lack of confidence that someone would catch the dangerous change in time.

## Competitive Landscape
**Direct:**  
strong_migrations, Eugene, Squawk, Atlas checks, Bytebase review flows, Liquibase governance.

**Secondary:**  
Internal migration review docs, DBA review checklists, platform team approval gates, generic CI linting.

**Indirect:**  
Careful manual review, staging-only validation, or “ship and monitor” habits.

**How they fall short:**  
Most alternatives either miss ORM workflows, live in the wrong language ecosystem, focus on execution rather than pre-merge understanding, or sell broad database workflow suites instead of focused migration safety.

## Differentiation
**Key differentiators:**  
- TypeScript-native, fits Node and TS teams naturally
- Understands multiple ORM migration formats
- Uses PostgreSQL’s real parser rather than superficial regex checks
- Shows exact lock modes and blocked operations
- Gives safe rewrite recipes, not just warnings
- Monetizes governance, not the analyzer

**How we do it differently:**  
We start from developer truth, what this statement locks and what it blocks, then layer governance for teams that need organizational control.

**Why that's better:**  
Developers can adopt the analyzer quickly with low friction, while engineering leaders get a clear path to paid controls if the governance layer proves valuable in design-partner conversations.

**Why prospects may choose us:**
Because they want fewer migration incidents without buying a giant database platform or forcing every team to become a Postgres expert.

## Objections
| Objection | Response |
|-----------|----------|
| “We already review migrations manually.” | pgfence gives consistent lock-level analysis and catches details manual review often misses under time pressure. |
| “We do not want another agent touching production.” | The analyzer runs locally today, and the planned governance workflow is designed to avoid asking for production database credentials. |
| “This feels niche.” | One blocked production table can cost more than the tool. It is niche in scope, not in impact. |
| “We already use Atlas / Bytebase / Liquibase.” | pgfence can complement broader platforms by focusing on pre-merge lock visibility and migration safety education. |

**Anti-persona:**  
Tiny hobby projects, teams without Postgres, teams with a strong in-house DBA process and no appetite for new tooling, or buyers looking for a full database deployment platform rather than a focused safety layer.

## Switching Dynamics
**Push:**  
Past migration pain, unreliable review quality, outage fear, and growing compliance pressure.

**Pull:**  
Fast adoption, exact lock visibility, safe rewrite help, and a governance layer that does not force a full process overhaul.

**Habit:**  
Teams are used to trusting ORM-generated files or ad hoc review comments.

**Anxiety:**  
Will this create noise? Will it slow teams down? Is the product mature enough to trust?

## Customer Language
**How they describe the problem:**  
- “A migration took down prod.”
- “We did not realize that change would block reads.”
- “The ORM made it look safe.”
- “We need guardrails around risky migrations.”
- “I want to know what this locks before I merge.”

**How they describe us:**  
- “A migration safety linter for Postgres.”
- “Something like strong_migrations, but for TypeScript and multiple ORMs.”
- “A way to review Postgres lock risk in CI.”

**Words to use:**  
lock modes, blocked reads and writes, migration safety, approvals, audit log, safe rewrite, expand/contract, pre-merge, production risk, trust boundary.

**Words to avoid:**  
AI hype, autonomous database agent, revolutionary, seamless, magic, optimize everything, generic “platform” language without specifics.

**Glossary:**
| Term | Meaning |
|------|---------|
| Analyzer | The free CLI and editor tooling that inspects migrations |
| Control plane | The planned paid governance layer being validated with design partners |
| Protected production database | The unit a paid plan is best aligned to |
| Safe rewrite | A safer sequence for shipping the intended schema change |

## Brand Voice
**Tone:**  
Calm, precise, credible, slightly sharp, incident-aware.

**Style:**  
Direct, technical, high-signal, respectful of developer intelligence.

**Personality:**  
Trustworthy, opinionated, careful, practical, technically literate.

## Proof Points
**Metrics:**  
- Hundreds of tests in the current core suite
- Multi-ORM support across TypeORM, Prisma, Knex, Drizzle, Sequelize, and raw SQL
- Lock-mode analysis based on PostgreSQL parser behavior

**Customers:**  
No public customer proof captured yet.

**Testimonials:**  
None documented yet.

**Value themes:**
| Theme | Proof |
|-------|-------|
| Prevent incidents | Flags dangerous lock-heavy migrations before merge |
| Fit developer workflow | CLI, CI, GitHub, GitLab, and editor support in the open-source analyzer |
| Low-trust-boundary adoption | The analyzer runs locally, and the planned governance workflow is designed around stats snapshots rather than production DB credentials |
| Governance for scale | The design-partner offer is centered on approvals, policy, and auditability rather than gating the core analyzer |

## Goals
**Business goal:**  
Land 3 to 5 design partners for the planned pgfence Cloud layer and validate packaging around migration governance.

**Conversion action:**  
Book a call or reply to a founder-led outreach email about the design partner program.

**Current metrics:**  
Not yet established in this document. Next step is to instrument pricing, cloud, and contact funnel events.
