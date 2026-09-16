-- pgfence telemetry: the queries that answer the question.
--
-- There is no dashboard and there will not be one. Run any of these with:
--   npx wrangler d1 execute pgfence-telemetry --remote --command "<one statement>"
--
-- All windows filter on received_at (server clock). The one exception is Q5, which is
-- about when people RUN pgfence rather than when the event arrived, and therefore has to
-- use client_ts. Note that client_ts is UTC: we deliberately do not collect a timezone,
-- so "weekday" here means UTC weekday, which smears by a few hours for anyone far from
-- UTC. That is good enough for a 1.8x ratio test and not good enough for anything finer.


-- ---------------------------------------------------------------------------
-- Q1. Distinct install ids in the last 7 and 30 days, interactive versus CI.
-- THE HEADCOUNT. If humans_30d is a handful while ci_ids_30d is large, the npm number is
-- machines, and the product decision is to stop optimizing for reach and start talking to
-- the few people who are actually there.
-- ---------------------------------------------------------------------------
SELECT
  COUNT(DISTINCT CASE WHEN ci = 0 AND received_at >= (unixepoch() -  7 * 86400) * 1000 THEN install_id END) AS humans_7d,
  COUNT(DISTINCT CASE WHEN ci = 1 AND received_at >= (unixepoch() -  7 * 86400) * 1000 THEN install_id END) AS ci_ids_7d,
  COUNT(DISTINCT CASE WHEN ci = 0 AND received_at >= (unixepoch() - 30 * 86400) * 1000 THEN install_id END) AS humans_30d,
  COUNT(DISTINCT CASE WHEN ci = 1 AND received_at >= (unixepoch() - 30 * 86400) * 1000 THEN install_id END) AS ci_ids_30d
FROM events
WHERE received_at >= (unixepoch() - 30 * 86400) * 1000;


-- ---------------------------------------------------------------------------
-- Q2. Run counts over the same window, for the ratio rather than the headcount.
-- If ci_runs dwarfs human_runs but ci_ids is close to ci_runs, those are one-shot
-- containers: the CI number is a build count, not a team count, and must never be quoted
-- as users.
-- ---------------------------------------------------------------------------
SELECT
  SUM(CASE WHEN ci = 0 THEN 1 ELSE 0 END)                  AS human_runs,
  SUM(CASE WHEN ci = 1 THEN 1 ELSE 0 END)                  AS ci_runs,
  COUNT(DISTINCT CASE WHEN ci = 0 THEN install_id END)     AS human_ids,
  COUNT(DISTINCT CASE WHEN ci = 1 THEN install_id END)     AS ci_ids,
  ROUND(1.0 * SUM(CASE WHEN ci = 0 THEN 1 ELSE 0 END) /
        MAX(COUNT(DISTINCT CASE WHEN ci = 0 THEN install_id END), 1), 2) AS runs_per_human
FROM events
WHERE received_at >= (unixepoch() - 30 * 86400) * 1000;


-- ---------------------------------------------------------------------------
-- Q3. THE NUMBER THE FEATURE EXISTS TO PRODUCE: interactive installs that came back on
-- more than one distinct day in the last 90 days.
-- A curiosity run counts once and never appears here. If returning_humans is near zero
-- while one_day_only is large, the problem is retention after the first run, not
-- awareness, and the next sprint belongs in onboarding rather than in outreach.
-- ---------------------------------------------------------------------------
SELECT
  SUM(CASE WHEN active_days >= 2 THEN 1 ELSE 0 END) AS returning_humans,
  SUM(CASE WHEN active_days  = 1 THEN 1 ELSE 0 END) AS one_day_only,
  COUNT(*)                                          AS all_humans_90d,
  ROUND(AVG(active_days), 2)                        AS avg_active_days
FROM (
  SELECT install_id, COUNT(DISTINCT day) AS active_days
  FROM events
  WHERE ci = 0 AND received_at >= (unixepoch() - 90 * 86400) * 1000
  GROUP BY install_id
);


-- ---------------------------------------------------------------------------
-- Q4. The same retention question as a histogram, so a single heavy user cannot hide
-- behind an average.
-- A long tail at 1 day with a thin spike at 10+ days means pgfence has a small number of
-- committed users and a leaky first run: build for the committed ones, fix the first run.
-- ---------------------------------------------------------------------------
SELECT active_days, COUNT(*) AS installs
FROM (
  SELECT install_id, COUNT(DISTINCT day) AS active_days
  FROM events
  WHERE ci = 0 AND received_at >= (unixepoch() - 90 * 86400) * 1000
  GROUP BY install_id
)
GROUP BY active_days
ORDER BY active_days;


-- ---------------------------------------------------------------------------
-- Q5. Weekday versus weekend, for interactive runs, on the CLIENT clock.
-- This is the direct test of the mirror hypothesis behind the 1.8x npm ratio. Real human
-- work is roughly 2.5x to 3.5x heavier per weekday than per weekend day. A ratio near 1.0
-- means whatever is generating the volume does not keep human hours, and the npm number
-- should be treated as machinery regardless of what it says.
-- ---------------------------------------------------------------------------
SELECT
  SUM(CASE WHEN strftime('%w', client_ts / 1000, 'unixepoch') IN ('0', '6') THEN 0 ELSE 1 END) AS weekday_runs,
  SUM(CASE WHEN strftime('%w', client_ts / 1000, 'unixepoch') IN ('0', '6') THEN 1 ELSE 0 END) AS weekend_runs,
  ROUND(
    (SUM(CASE WHEN strftime('%w', client_ts / 1000, 'unixepoch') IN ('0', '6') THEN 0 ELSE 1 END) / 5.0) /
    MAX(SUM(CASE WHEN strftime('%w', client_ts / 1000, 'unixepoch') IN ('0', '6') THEN 1 ELSE 0 END) / 2.0, 1.0)
  , 2) AS per_day_weekday_to_weekend_ratio
FROM events
WHERE ci = 0 AND received_at >= (unixepoch() - 90 * 86400) * 1000;


-- ---------------------------------------------------------------------------
-- Q6. Same split, per day of week, as a sanity check on Q5.
-- A flat line across all seven days is machinery. A visible Saturday and Sunday dip is
-- people. Read this before quoting Q5 to anyone.
-- ---------------------------------------------------------------------------
SELECT
  strftime('%w', client_ts / 1000, 'unixepoch') AS dow_0_is_sunday,
  COUNT(*)                                      AS runs,
  COUNT(DISTINCT install_id)                    AS installs
FROM events
WHERE ci = 0 AND received_at >= (unixepoch() - 90 * 86400) * 1000
GROUP BY dow_0_is_sunday
ORDER BY dow_0_is_sunday;


-- ---------------------------------------------------------------------------
-- Q7. Which ORM ecosystems are actually used, BY DISTINCT INSTALL, not by run count.
-- One CI matrix running typeorm 400 times a day would dominate a run count and produce
-- exactly the wrong extractor roadmap. Whichever format leads installs here is where the
-- next extractor and the next integration guide go; formats with zero installs after a
-- quarter are maintenance debt.
-- ---------------------------------------------------------------------------
SELECT
  format,
  COUNT(DISTINCT install_id)                              AS installs,
  COUNT(DISTINCT CASE WHEN ci = 0 THEN install_id END)    AS human_installs,
  COUNT(*)                                                AS runs
FROM events
WHERE received_at >= (unixepoch() - 90 * 86400) * 1000
GROUP BY format
ORDER BY human_installs DESC, installs DESC;


-- ---------------------------------------------------------------------------
-- Q8. Error rate: what fraction of runs hit the CLI's catch block and exited 2.
-- Above roughly 2 percent is a bug report nobody filed. Break it out by version before
-- shipping anything else.
-- ---------------------------------------------------------------------------
SELECT
  COUNT(*)                                                   AS runs,
  SUM(errored)                                               AS errored_runs,
  ROUND(100.0 * SUM(errored) / MAX(COUNT(*), 1), 2)          AS errored_pct,
  COUNT(DISTINCT CASE WHEN errored = 1 THEN install_id END)  AS installs_that_hit_an_error
FROM events
WHERE received_at >= (unixepoch() - 30 * 86400) * 1000;


-- ---------------------------------------------------------------------------
-- Q9. Error rate by version and command, so a regression can be pinned to a release.
-- A version whose errored_pct jumps against its predecessor is a release to yank or
-- patch, and this is the only signal that surfaces it without someone opening an issue.
-- ---------------------------------------------------------------------------
SELECT version, command, COUNT(*) AS runs, ROUND(100.0 * SUM(errored) / MAX(COUNT(*), 1), 2) AS errored_pct
FROM events
WHERE received_at >= (unixepoch() - 60 * 86400) * 1000
GROUP BY version, command
HAVING runs >= 5
ORDER BY errored_pct DESC, runs DESC;


-- ---------------------------------------------------------------------------
-- Q10. Findings per run, for interactive runs: is pgfence pointed at real migrations or
-- at a single toy file.
-- A large clean_runs share next to file_count_bucket 0 or 1 means people are smoke
-- testing, and the headcount is softer than it looks. A healthy runs_with_serious share
-- on buckets 3 and up means it is wired into real repositories and the CI gate is the
-- feature to invest in.
-- ---------------------------------------------------------------------------
SELECT
  file_count_bucket,
  COUNT(*) AS runs,
  COUNT(DISTINCT install_id) AS installs,
  SUM(CASE WHEN find_safe + find_low + find_medium + find_high + find_critical
                + policy_errors + policy_warnings = 0 THEN 1 ELSE 0 END) AS clean_runs,
  SUM(CASE WHEN find_high + find_critical + policy_errors > 0 THEN 1 ELSE 0 END) AS runs_with_serious_findings,
  ROUND(AVG(find_safe + find_low + find_medium + find_high + find_critical), 1) AS avg_findings,
  ROUND(AVG(policy_errors + policy_warnings), 1) AS avg_policy_violations
FROM events
WHERE ci = 0 AND received_at >= (unixepoch() - 30 * 86400) * 1000
GROUP BY file_count_bucket
ORDER BY file_count_bucket;


-- ---------------------------------------------------------------------------
-- Q11. Findings-per-run histogram, bucketed, so the shape is visible rather than averaged.
-- Everything piled in the "0" bucket means people run pgfence on migrations it has
-- nothing to say about, which is a rules-coverage problem, not an adoption problem.
-- ---------------------------------------------------------------------------
SELECT
  CASE
    WHEN total = 0 THEN '0'
    WHEN total BETWEEN 1 AND 2   THEN '1-2'
    WHEN total BETWEEN 3 AND 5   THEN '3-5'
    WHEN total BETWEEN 6 AND 20  THEN '6-20'
    ELSE '20+'
  END AS findings_bucket,
  COUNT(*) AS runs,
  COUNT(DISTINCT install_id) AS installs
FROM (
  SELECT install_id,
         find_safe + find_low + find_medium + find_high + find_critical
           + policy_errors + policy_warnings AS total
  FROM events
  WHERE ci = 0 AND received_at >= (unixepoch() - 30 * 86400) * 1000
)
GROUP BY findings_bucket
ORDER BY runs DESC;


-- ---------------------------------------------------------------------------
-- Q12. Ephemeral-container check: what share of CI install ids were minted that run.
-- A fresh_id_share near 1.0 confirms that ci_ids in Q1 counts containers, not teams, and
-- forbids quoting it as a customer number in any external material.
-- ---------------------------------------------------------------------------
SELECT ci_provider, COUNT(*) AS runs, ROUND(AVG(fresh_install_id), 3) AS fresh_id_share
FROM events
WHERE ci = 1 AND received_at >= (unixepoch() - 30 * 86400) * 1000
GROUP BY ci_provider
ORDER BY runs DESC;


-- ---------------------------------------------------------------------------
-- Q13. Which commands humans actually run.
-- If this is 100 percent analyze, trace and explain are shelfware and the next release
-- should either promote them or stop carrying them.
-- ---------------------------------------------------------------------------
SELECT command, COUNT(*) AS runs, COUNT(DISTINCT install_id) AS installs
FROM events
WHERE ci = 0 AND received_at >= (unixepoch() - 30 * 86400) * 1000
GROUP BY command
ORDER BY installs DESC;


-- ---------------------------------------------------------------------------
-- Q14. Configured installs versus drive-by runs.
-- rules_mode other than 'default', or plugin_count above 0, is the strongest adoption
-- signal available: someone sat down and configured the tool. If that count is zero,
-- nobody has adopted pgfence yet no matter what the headcount says.
-- ---------------------------------------------------------------------------
SELECT
  rules_mode,
  SUM(CASE WHEN plugin_count > 0 THEN 1 ELSE 0 END) AS runs_with_plugins,
  COUNT(*)                                          AS runs,
  COUNT(DISTINCT install_id)                        AS installs
FROM events
WHERE ci = 0 AND received_at >= (unixepoch() - 90 * 86400) * 1000
GROUP BY rules_mode
ORDER BY installs DESC;


-- ---------------------------------------------------------------------------
-- Q15. Version adoption among humans: how fast do people upgrade.
-- If the current release is a minority of installs a month after publish, release notes
-- and upgrade friction are the problem, and a new feature will not reach anyone.
-- ---------------------------------------------------------------------------
SELECT version, COUNT(DISTINCT install_id) AS installs, COUNT(*) AS runs
FROM events
WHERE ci = 0 AND received_at >= (unixepoch() - 30 * 86400) * 1000
GROUP BY version
ORDER BY installs DESC;


-- ---------------------------------------------------------------------------
-- Q16. Platform and runtime support matrix.
-- A Node major or an OS with zero installs over 90 days is one we can stop testing
-- against; a large win32 share means the Windows path is load bearing and cannot rot.
-- ---------------------------------------------------------------------------
SELECT os, node_major, COUNT(DISTINCT install_id) AS installs, COUNT(*) AS runs
FROM events
WHERE ci = 0 AND received_at >= (unixepoch() - 90 * 86400) * 1000
GROUP BY os, node_major
ORDER BY installs DESC;


-- ---------------------------------------------------------------------------
-- Q17. Run duration, to catch a performance regression before people quietly stop using it.
-- A p95 above a couple of seconds on small buckets is a regression: pgfence is sold as a
-- pre-merge check and a slow pre-merge check gets removed from the pipeline.
-- ---------------------------------------------------------------------------
SELECT
  file_count_bucket,
  COUNT(*) AS runs,
  MIN(duration_ms) AS min_ms,
  ROUND(AVG(duration_ms)) AS avg_ms,
  MAX(duration_ms) AS max_ms
FROM events
WHERE received_at >= (unixepoch() - 30 * 86400) * 1000
GROUP BY file_count_bucket
ORDER BY file_count_bucket;


-- ---------------------------------------------------------------------------
-- Q18. Delivery lag for interactive events, in minutes: a health check on the client spool.
-- Interactive events are delivered by a LATER run, so a rising max_lag_minutes means the
-- spool is backing up and every count above is a bigger undercount than usual.
-- ---------------------------------------------------------------------------
SELECT
  COUNT(*) AS events,
  ROUND(AVG(received_at - client_ts) / 60000.0, 1) AS avg_lag_minutes,
  MAX(received_at - client_ts) / 60000             AS max_lag_minutes
FROM events
WHERE ci = 0 AND received_at >= (unixepoch() - 7 * 86400) * 1000;


-- ---------------------------------------------------------------------------
-- Q19. Daily volume, for eyeballing a spike.
-- The endpoint is unauthenticated by design, so a sudden jump is a probe or a prank until
-- proven otherwise. Check this before believing any number above it.
-- ---------------------------------------------------------------------------
SELECT day,
       COUNT(*) AS events,
       COUNT(DISTINCT install_id) AS install_ids,
       SUM(CASE WHEN ci = 0 THEN 1 ELSE 0 END) AS human_events
FROM events
WHERE received_at >= (unixepoch() - 60 * 86400) * 1000
GROUP BY day
ORDER BY day DESC;


-- ---------------------------------------------------------------------------
-- RETENTION. 400 days, enforced by the scheduled handler in src/index.ts, which runs
-- this exact DELETE daily at 04:17 UTC. Run it by hand to enforce retention immediately,
-- for example after changing the stated window in docs/telemetry.md.
-- ---------------------------------------------------------------------------
DELETE FROM events WHERE received_at < (unixepoch() - 400 * 86400) * 1000;
