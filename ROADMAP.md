# pgfence Roadmap

## Current State (v0.1.5, Feb 2026)

- 28 DDL checks, 6 ORM extractors, 3 output formats + SARIF
- Published on npm as `@flvmnt/pgfence`
- GitHub Action exists
- Zero community traction (0 stars, 0 external users, no search presence)

The tool is technically solid. The problem is distribution, not features.

---

## Phase 0 — Distribution & Community (Now → 500 stars)

Nothing else matters until people use pgfence. No cloud features, no execution engine, no paid tier. Every hour spent on monetization before product-market fit is wasted.

### 0.1 — Make the GitHub Action Flawless

The GitHub Action is the distribution engine. Every team that installs it sees pgfence in every PR. It must be zero-config, produce beautiful inline annotations, and "just work."

- [ ] Inline PR annotations via SARIF upload (not just a comment block)
- [ ] Zero-config: auto-detect migration format, auto-find migration files
- [ ] One-line install: `uses: flvmnt/pgfence@v1` with sensible defaults
- [ ] Screenshot-worthy PR comment output (this is marketing material)

### 0.2 — Content & SEO

Write the content that makes pgfence discoverable.

- [ ] **"Show HN" post** — launch post with the demo output front and center
- [ ] **Blog post: "How ADD COLUMN NOT NULL took down our 12M-row table"** — SEO bait that ranks for migration safety queries. Explain the lock mode semantics, show pgfence catching it.
- [ ] **Blog post: "The Postgres Lock Mode Cheat Sheet for Developers"** — reference content that developers bookmark and share. Link to pgfence at the bottom.
- [ ] **Blog post: "TypeORM Migrations Are Dangerous (Here's How to Check)"** — target the TypeORM community specifically, they have zero tooling for this
- [ ] Post in: r/postgres, r/node, TypeORM Discord, Prisma Discord, Postgres Weekly newsletter, Node Weekly newsletter

### 0.3 — Free Migration Audits for Credibility

Offer to audit migrations of popular open-source TypeScript/Postgres projects. This generates case studies, backlinks, and potential stars/mentions.

Targets:
- [ ] Cal.com (TypeScript, Prisma, Postgres)
- [ ] Supabase (TypeScript, Postgres-native)
- [ ] Documenso (TypeScript, Prisma, Postgres)
- [ ] Infisical (TypeScript, Knex, Postgres)
- [ ] Any popular TypeORM project with public migrations

Format: Open an issue or PR titled "Migration safety audit — found N issues" with pgfence's full report. High-value contribution, great visibility.

### 0.4 — Developer Experience Polish

- [ ] `pgfence init` — 30-second onboarding: detect project, install hook, done
- [ ] Improve CLI output aesthetics (the table output is marketing)
- [ ] `--watch` mode for local development
- [ ] VS Code problem matcher integration (so pgfence errors show inline in the editor)

### Exit Criteria for Phase 0

Move to Phase 1 when:
- 500+ GitHub stars
- 1K+ npm downloads/week (organic, not self-installs)
- At least 3 unsolicited GitHub issues from external users
- pgfence appears in search results for "postgres migration safety"

---

## Phase 1 — Technical Gaps (Concurrent with Phase 0)

These are feature gaps that hurt credibility and cause false negatives. Work on these alongside distribution, in priority order.

### Quick Wins (1-2 hours each)

| # | Gap | Why It Matters |
|---|-----|----------------|
| 1 | `ALTER TYPE ... ADD VALUE` (enum) | Extremely common, huge blind spot |
| 2 | `lock_timeout` ordering validation | Catches real false negatives — timeout set after DDL is useless |
| 3 | `REINDEX` (non-concurrent) | Common maintenance, ACCESS EXCLUSIVE |
| 4 | `REFRESH MATERIALIZED VIEW` | Blocks reads, common pattern |
| 5 | Timeout value validation (`> 5s` = warning) | Prevents `SET lock_timeout = '5min'` from passing |
| 6 | `CREATE/DROP TRIGGER` | ACCESS EXCLUSIVE, not flagged at all |
| 7 | `ALTER TABLE ... ATTACH/DETACH PARTITION` | Partitioning is increasingly standard |

### Medium Effort (half day each)

| # | Gap | Why It Matters |
|---|-----|----------------|
| 8 | Cross-file migration state | Eliminates false positives for batched migrations |
| 9 | Per-rule enable/disable config (`pgfence.config.ts`) | Quality of life for adoption |
| 10 | Schema snapshot (`pgfence snapshot`) | Accurate type change analysis without live DB |
| 11 | Conditional SQL warnings in extractors | Better coverage reporting |

### Heavy Lift (days, defer until Phase 0 exit criteria met)

| # | Gap | Why It Matters |
|---|-----|----------------|
| 12 | Transaction state machine | Proper savepoint/lock modeling |
| 13 | Knex/Sequelize schema builder transpilation | Builder API → SQL → analysis |
| 14 | Plugin system for custom rules | Extensibility for teams |

---

## Phase 2 — First Revenue (After Phase 0 exit criteria)

Only start this when pgfence has real organic adoption. The monetization model depends on what users are actually asking for by then. Current best guesses, in order of feasibility for a solo maintainer:

### Option A: GitHub App (Recommended First)

Ship as a GitHub App. GitHub handles auth, billing, installation. You run the analysis.

- **Free tier**: CLI, basic GitHub Action, JSON output
- **Paid tier ($19/mo per repo)**:
  - Auto-fix mode: rewrites dangerous SQL into safe SQL, commits to PR
  - Slack/Discord notifications on HIGH+ risk migrations
  - Team-level rule configuration (`.pgfence.cloud.yml`)
  - Historical migration risk dashboard per repo

Why GitHub App first: no auth system to build, no billing to manage, instant distribution via GitHub Marketplace, trust by association.

### Option B: Migration Audit Service

One-time paid audits ($200-500) for teams that want a human review of their migration suite. Run pgfence, write up findings, provide remediation plan. Doesn't scale, but generates cash flow and case studies.

### Option C: Sponsored Features

Advanced rules/extractors unlocked for GitHub Sponsors. Keeps everything open-source but gates premium analysis behind sponsorship.

---

## Phase 3 — Platform (12-18 months out, re-evaluate then)

These are the high-ceiling ideas. Don't build any of this until Phase 2 is generating revenue and you've validated demand through conversations with paying users.

### Execution Engine

Instead of just analyzing, pgfence executes the safe version of your migration. You write the dangerous DDL, pgfence rewrites and runs the expand/contract sequence with retry logic, progress reporting, and automatic rollback.

This is the "PlanetScale for Postgres" play. It's genuinely hard to build safely — one bug means data corruption. Requires:
- Extensive integration testing against PG 11-17
- Battle-testing at real scale (10M+ row tables)
- Careful error handling and rollback for every edge case

Don't attempt this solo. This is the feature that justifies raising money or finding a co-maintainer.

### Organizational Governance

- Approval workflows: HIGH+ risk migrations require sign-off
- Policy engine: "No ACCESS EXCLUSIVE on tables > 1M rows without exemption"
- Audit trail: immutable log of every migration, who approved it, what risk
- Exemptions with expiry
- Schema drift detection

This is what you charge $50K-500K/year for. But it requires enterprise sales, which requires a team, which requires funding or revenue from Phase 2.

---

## Architecture Limitations (Reference)

Honest accounting of what pgfence cannot do today. Each is a potential false negative.

### No Schema Awareness

pgfence has zero knowledge of actual database state. Can't verify if `varchar(36) -> varchar(64)` is truly a widening. Can't tell if a table has 0 rows or 100M rows without stats.

**Mitigation:** `pgfence snapshot` command (Phase 1, item 10) that dumps schema metadata alongside stats. No credentials needed at analysis time.

### Single-File Stateless Analysis

Each migration analyzed in isolation. No cross-file ordering, no cumulative lock duration modeling, no "migration A created this table, migration B can safely index it."

**Mitigation:** Track a lightweight migration graph (Phase 1, item 8). Carry forward `createdTables` / `alteredColumns` set across files when analyzing a batch.

### No Transaction Modeling Beyond Depth Counting

The policy checker tracks `txDepth` but doesn't model savepoints, deferred constraints, or combined lock window duration.

**Mitigation:** Transaction state machine (Phase 1, item 12). Track `BEGIN`, `SAVEPOINT`, `RELEASE`, `COMMIT`, `ROLLBACK TO`.

### Extractor Blind Spots

- Conditional SQL in ORMs (`if (condition) { await qr.query(...) }`) never extracted
- Knex `createTable()` / Sequelize `queryInterface.addColumn()` builder APIs can't be reverse-engineered to SQL
- Drizzle Kit push mode has no migration files to analyze
- MikroORM, Kysely, Slonik not supported

---

## Competitive Landscape

| Tool | Stars | Language | Analyzes | Executes | Governs | Ecosystem |
|------|-------|---------|----------|----------|---------|-----------|
| strong_migrations | ~4K | Ruby | Yes | No | No | Rails only |
| Squawk | ~3K | Rust | Yes | No | No | SQL-native |
| pgroll | ~3K | Go | No | Yes (own YAML) | No | Go |
| Eugene | ~800 | Rust | Yes | No | No | Rust |
| Atlas | ~6K | Go | Yes | Yes | Partial | Multi-DB |
| **pgfence** | **0** | **TypeScript** | **Yes** | **No** | **No** | **Node/TS** |

pgfence's moat is the Node.js/TypeScript ecosystem. Nobody else does ORM extraction for TypeORM, Prisma, Knex, Drizzle, and Sequelize. The gap to close is trust and adoption, not features.

---

## Testing Strategy

### Fast Path (every PR)

- Unit tests + fixture tests (no Docker, no DB)
- Must complete in < 30 seconds

### Slow Path (nightly / pre-release)

- Docker Compose with PG 11-17
- Lock mode verification: execute DDL in one connection, query `pg_locks` from another, assert pgfence's prediction matches reality
- Shadow database: known schema + `pgfence extract-stats` + full analysis pipeline

### Real-World Corpus

Validate against migrations from open-source projects:
- GitLab CE/EE (`db/migrate/`, 4000+ migrations)
- Mastodon, Discourse, Supabase
- Squawk, Eugene, strong_migrations test suites (any pattern they catch that we miss is a gap)

### Scale Calibration (weekly / pre-major-release)

Generate tables at each risk tier boundary (1K, 100K, 1M, 10M rows), run dangerous DDL under concurrent workload, measure lock duration. If measured impact doesn't correlate with pgfence's risk levels, recalibrate thresholds.

---

## The Rule

**Distribution before features. Features before monetization. Monetization before platform.**

Stop building what nobody's asked for. Start making people care.
