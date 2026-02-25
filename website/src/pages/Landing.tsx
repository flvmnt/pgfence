import { useState } from 'react';
import { motion } from 'framer-motion';
import { TiltCard } from '../components/TiltCard';
import TopNav from '../components/TopNav';

const installCommand = 'npm install -g @flvmnt/pgfence';

const stats = [
  { value: '28', label: 'safety checks across lock, policy, and transaction risks' },
  { value: '6', label: 'extractors for SQL, TypeORM, Prisma, Knex, Drizzle, and Sequelize' },
  { value: '100%', label: 'coverage visibility with analyzable vs dynamic SQL reporting' },
];

const features = [
  {
    kicker: 'Predict',
    title: 'Know lock impact before merge',
    description:
      'pgfence maps every DDL statement to PostgreSQL lock modes, blockers, and blast radius so reviewers can decide with full operational context.',
  },
  {
    kicker: 'Enforce',
    title: 'Turn policy into guardrails',
    description:
      'Require lock_timeout, statement_timeout, and transaction-safe migration patterns by default, then fail fast when a migration breaks your reliability contract.',
  },
  {
    kicker: 'Rewrite',
    title: 'Ship with proven safe recipes',
    description:
      'Get expand/contract sequences for high-risk schema changes, including concurrent index creation and staged NOT NULL rollouts.',
  },
];

const workflow = [
  {
    step: '01',
    title: 'Analyze migration files',
    description: 'Parse SQL and ORM migrations with the PostgreSQL parser to classify each operation accurately.',
  },
  {
    step: '02',
    title: 'Score operational risk',
    description:
      'Combine lock severity with optional table stats to detect migrations likely to block reads, writes, or both.',
  },
  {
    step: '03',
    title: 'Gate and guide release',
    description:
      'Fail CI for risky changes and provide concrete safe rewrites so teams can ship without downtime.',
  },
];

const comparisonRows = [
  {
    capability: 'Lock mode visibility',
    pgfence: 'Explicit per statement',
    generic: 'Partial pattern checks',
    manual: 'Reviewer dependent',
  },
  {
    capability: 'ORM extraction',
    pgfence: 'TypeORM + Prisma + Knex + SQL',
    generic: 'Usually SQL only',
    manual: 'Manual parsing',
  },
  {
    capability: 'Safe rewrite output',
    pgfence: 'Expand/contract recipes',
    generic: 'Warnings only',
    manual: 'Ad hoc docs',
  },
  {
    capability: 'CI gate readiness',
    pgfence: 'Risk threshold + policy checks',
    generic: 'Limited signals',
    manual: 'No automation',
  },
];

function Landing() {
  const [copied, setCopied] = useState(false);

  const handleCopyInstall = async () => {
    try {
      await navigator.clipboard.writeText(installCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (error) {
      console.error('Failed to copy install command', error);
    }
  };

  return (
    <div className="landing-root">
      <TopNav />
      <div className="app-container">
        <header className="hero">
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
          >
            Know what your migration will lock
            <br />
            <span className="text-dim">before it hits production.</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.1, ease: 'easeOut' }}
            className="hero-subtitle"
          >
            pgfence makes migration risk visible before deployment with deterministic lock analysis, policy checks, and safe rewrites that keep production stable.
          </motion.p>

          <motion.div
            className="cta-row"
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.2, ease: 'easeOut' }}
          >
            <a
              href="https://github.com/flvmnt/pgfence"
              target="_blank"
              rel="noreferrer"
              className="cta-icon"
              aria-label="GitHub repository"
              title="GitHub repository"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M8 0C3.58 0 0 3.58 0 8a8.01 8.01 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.72 7.72 0 0 1 4 0c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
                />
              </svg>
            </a>
            <a
              href="https://www.npmjs.com/package/@flvmnt/pgfence"
              target="_blank"
              rel="noreferrer"
              className="cta-icon"
              aria-label="npm package"
              title="npm package"
            >
              <svg viewBox="0 0 780 250" aria-hidden="true">
                <path
                  fill="currentColor"
                  d="M240,250h100v-50h100V0H240V250z M340,50h50v100h-50V50z M480,0v200h100V50h50v150h50V50h50v150h50V0H480z M0,200h100V50h50v150h50V0H0V200z"
                />
              </svg>
            </a>
          </motion.div>
        </header>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2, ease: 'easeOut' }}
          className="terminal-wrap"
        >
          <TiltCard intensity={3}>
            <div className="terminal">
              <div className="terminal-header">
                <div className="dots">
                  <div className="dot dot-red" />
                  <div className="dot dot-yellow" />
                  <div className="dot dot-green" />
                </div>
                <div className="terminal-title">pgfence</div>
              </div>
              <div className="terminal-body">
                <div className="cmd-line cmd-line-copy">
                  <span className="cmd-prompt">$</span>
                  <span className="cmd-text">{installCommand}</span>
                  <button
                    type="button"
                    className={`copy-btn${copied ? ' copied' : ''}`}
                    aria-label="Copy install command"
                    title={copied ? 'Copied' : 'Copy command'}
                    onClick={() => void handleCopyInstall()}
                  >
                    {copied ? (
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
                        <path d="M10.5 5.5V3.5C10.5 2.67 9.83 2 9 2H3.5C2.67 2 2 2.67 2 3.5V9C2 9.83 2.67 10.5 3.5 10.5H5.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
                      </svg>
                    )}
                  </button>
                </div>
                <div className="cmd-output dim">added 26 packages in 4s</div>

                <div className="cmd-line cmd-line-gap">
                  <span className="cmd-prompt">$</span>
                  <span className="cmd-text">pgfence analyze migrations/add-email-verified.sql</span>
                </div>

                <div className="cli-output">
                  <div className="cli-file-header">
                    migrations/add-email-verified.sql&ensp;<span className="risk-badge risk-high">HIGH</span>
                  </div>
                  <div className="cli-file-summary dim" style={{ padding: '0 1rem 1rem', fontSize: '0.85rem' }}>
                    Lock: ACCESS EXCLUSIVE | Blocks: reads+writes+DDL | Risk: HIGH | Rule: add-column-not-null-no-default, create-index-not-concurrent
                  </div>

                  <pre className="cli-table-pre">{
                    `┌────┬──────────────────────────────────────────────┬────────────────────┬────────────────┬────────────┐
│ #  │ Statement                                    │ Lock Mode          │ Blocks         │ Risk       │
├────┼──────────────────────────────────────────────┼────────────────────┼────────────────┼────────────┤
│ 1  │ ALTER TABLE users ADD COLUMN email_verified  │ ACCESS EXCLUSIVE   │ reads, writes, │ `}<span className="risk-high">HIGH</span>{`       │
│    │ BOOLEAN NOT NULL ...                         │                    │ DDL            │            │
├────┼──────────────────────────────────────────────┼────────────────────┼────────────────┼────────────┤
│ 2  │ CREATE INDEX idx_users_email ON users(email) │ SHARE              │ writes, DDL    │ `}<span className="risk-medium">MEDIUM</span>{`     │
└────┴──────────────────────────────────────────────┴────────────────────┴────────────────┴────────────┘`}
                  </pre>

                  <div className="cli-danger-panel">
                    <div className="cli-panel-label">Policy Violations</div>
                    <div className="cli-violation">
                      <span className="violation-tag">ERROR</span> Missing SET lock_timeout
                    </div>
                    <div className="cli-suggestion">&#8594; Add SET lock_timeout = '2s'; at the start of the migration</div>
                  </div>

                  <div className="cli-safe-panel">
                    <div className="cli-panel-label">Safe Rewrite Recipes</div>
                    <div className="cli-recipe-name">add-column-not-null-no-default</div>
                    <pre className="cli-recipe-pre">{
                      `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean;
`}<span className="dim">{`-- Backfill in batches out-of-band`}</span>{`
ALTER TABLE users ADD CONSTRAINT chk_nn CHECK (email_verified IS NOT NULL) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT chk_nn;
ALTER TABLE users ALTER COLUMN email_verified SET NOT NULL;
ALTER TABLE users DROP CONSTRAINT chk_nn;`}
                    </pre>

                    <div className="cli-recipe-name" style={{ marginTop: '1rem' }}>create-index-not-concurrent</div>
                    <pre className="cli-recipe-pre">{
                      `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email ON users(email);
`}<span className="dim">{`-- Note: CONCURRENTLY must run outside a transaction block`}</span>{`
`}
                    </pre>
                  </div>

                  <div className="cli-coverage">
                    <div style={{ marginBottom: '0.25rem', color: '#fff' }}>=== Coverage ===</div>
                    <div style={{ marginBottom: '0.25rem', color: '#a0aec0' }}>Postgres ruleset: PG11+ (configurable)</div>
                    <div style={{ color: '#a0aec0' }}>Analyzed: 2 statements &nbsp;| Unanalyzable: 0 &nbsp;| Coverage: <span className="risk-safe">100%</span></div>
                  </div>
                </div>
              </div>
            </div>
          </TiltCard>
        </motion.div>

        <section className="stats">
          {stats.map((item) => (
            <motion.div
              key={item.value}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: '-120px' }}
              transition={{ duration: 0.5 }}
              className="stat-card"
            >
              <span className="stat-value">{item.value}</span>
              <p>{item.label}</p>
            </motion.div>
          ))}
        </section>

        <section className="features">
          {features.map((feature) => (
            <TiltCard key={feature.title} intensity={3}>
              <div className="feature-card">
                <p className="feature-kicker">{feature.kicker}</p>
                <h3>{feature.title}</h3>
                <p>{feature.description}</p>
              </div>
            </TiltCard>
          ))}
        </section>

        <motion.section
          className="workflow"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-120px' }}
          transition={{ duration: 0.7 }}
        >
          <h2 className="section-title">
            Built for teams that cannot afford migration downtime
            <span>From first commit to deployment approval, pgfence keeps schema changes deterministic.</span>
          </h2>
          <div className="workflow-grid">
            {workflow.map((item) => (
              <div key={item.step} className="workflow-card">
                <div className="workflow-step">{item.step}</div>
                <h3>{item.title}</h3>
                <p>{item.description}</p>
              </div>
            ))}
          </div>
        </motion.section>

        <motion.section
          className="comparison-section"
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-100px' }}
          transition={{ duration: 0.8 }}
        >
          <h2 className="section-title">
            Why engineering teams choose pgfence
            <span>Deep Postgres lock intelligence with implementation-ready guidance.</span>
          </h2>
          <div className="comparison-table-wrap">
            <table className="comparison-table">
              <thead>
                <tr>
                  <th>Capability</th>
                  <th className="highlight-col">pgfence</th>
                  <th>Generic SQL linters</th>
                  <th>Manual review</th>
                </tr>
              </thead>
              <tbody>
                {comparisonRows.map((row) => (
                  <tr key={row.capability}>
                    <td>{row.capability}</td>
                    <td className="highlight-col">{row.pgfence}</td>
                    <td className="text-muted">{row.generic}</td>
                    <td className="text-muted">{row.manual}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </motion.section>

        <footer className="footer-minimal">
          <p>Source-available &middot; FSL-1.1-MIT &middot; <a href="/docs/introduction" className="footer-link">Docs</a> &middot; <a href="https://github.com/flvmnt/pgfence" target="_blank" rel="noreferrer" className="footer-link">GitHub</a> &middot; <a href="https://www.npmjs.com/package/@flvmnt/pgfence" target="_blank" rel="noreferrer" className="footer-link">npm</a> &middot; <a href="mailto:contact@pgfence.com" className="footer-link">contact@pgfence.com</a></p>
        </footer>
      </div>
    </div>
  );
}

export default Landing;
