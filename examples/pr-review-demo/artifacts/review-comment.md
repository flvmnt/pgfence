## pgfence Migration Safety Report

### <code>examples/pr-review-demo/migrations/20260415_add_last_seen_at.sql</code> :red_circle: HIGH

| # | Statement | Lock Mode | Blocks | Risk | Message |
|---|-----------|-----------|--------|------|---------|
| 1 | <code>ALTER TABLE users ADD COLUMN last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()</code> | <code>ACCESS EXCLUSIVE</code> | <code>reads, writes, DDL</code> | :red_circle: HIGH | <code>ADD COLUMN &quot;last_seen_at&quot; with non-constant DEFAULT: causes table rewrite under ACCESS EXCLUSIVE lock. Column is also NOT NULL, requiring an additional constraint step</code> |
| 2 | <code>CREATE INDEX idx_users_last_seen_at ON users (last_seen_at)</code> | <code>SHARE</code> | <code>writes, DDL</code> | :warning: MEDIUM | <code>CREATE INDEX &quot;idx_users_last_seen_at&quot; without CONCURRENTLY: acquires SHARE lock, blocking all writes on &quot;users&quot;</code> |

<details>
<summary>Safe Rewrite Recipes</summary>

#### <code>add-column-non-constant-default</code> <code>Add column without default, backfill in batches, then set default</code>
<pre><code class="language-sql">
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
-- Backfill out-of-band in batches (repeat until 0 rows updated):
-- WITH batch AS (
--   SELECT ctid FROM users WHERE last_seen_at IS NULL LIMIT 1000 FOR UPDATE SKIP LOCKED
-- )
-- UPDATE users t SET last_seen_at = &lt;fill_value&gt; FROM batch WHERE t.ctid = batch.ctid;
ALTER TABLE users ALTER COLUMN last_seen_at SET DEFAULT &lt;fill_value&gt;;
ALTER TABLE users ADD CONSTRAINT chk_last_seen_at_nn CHECK (last_seen_at IS NOT NULL) NOT VALID;
ALTER TABLE users VALIDATE CONSTRAINT chk_last_seen_at_nn;
ALTER TABLE users ALTER COLUMN last_seen_at SET NOT NULL;
ALTER TABLE users DROP CONSTRAINT chk_last_seen_at_nn;
</code></pre>

#### <code>create-index-not-concurrent</code> <code>Use CREATE INDEX CONCURRENTLY to allow reads and writes during index build.</code>
<pre><code class="language-sql">
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_last_seen_at ON users (last_seen_at);
-- Note: CONCURRENTLY must run outside a transaction block (disable ORM transaction wrappers)
</code></pre>

</details>

**Policy Violations:**

| Severity | Rule | Message | Suggestion |
|----------|------|---------|------------|
| :red_circle: error | <code>missing-lock-timeout</code> | <code>Missing SET lock_timeout: without this, an ACCESS EXCLUSIVE lock will queue behind running queries and every new query queues behind it, causing a lock queue death spiral</code> | <code>Add SET lock_timeout = &#39;2s&#39;; at the start of the migration</code> |
| :warning: warning | <code>missing-statement-timeout</code> | <code>Missing SET statement_timeout: long-running operations can block other queries indefinitely</code> | <code>Add SET statement_timeout = &#39;5min&#39;; at the start of the migration</code> |
| :warning: warning | <code>missing-application-name</code> | <code>Missing SET application_name: makes it harder to identify migration locks in pg_stat_activity</code> | <code>Add SET application_name = &#39;migrate:&lt;migration_name&gt;&#39;;</code> |
| :warning: warning | <code>missing-idle-timeout</code> | <code>Missing SET idle_in_transaction_session_timeout: orphaned connections with open transactions can hold locks indefinitely</code> | <code>Add SET idle_in_transaction_session_timeout = &#39;30s&#39;;</code> |

### Coverage

Analyzed **2** SQL statements. **0** dynamic statements not analyzable. Coverage: **100%**

---
*[pgfence](https://pgfence.com) migration safety report*
