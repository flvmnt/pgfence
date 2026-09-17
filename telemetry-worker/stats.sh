#!/usr/bin/env bash
# The headcount, in one command. See queries.sql for the rest and for what each number means.
set -euo pipefail
cd "$(dirname "$0")"

q() {
  npx --yes wrangler@latest d1 execute pgfence-telemetry --remote --command "$2" --json 2>/dev/null \
    | python3 -c "
import json,sys,re
m=re.search(r'(\[.*\])', sys.stdin.read(), re.S)
if not m: print('  query failed'); raise SystemExit(1)
rows=json.loads(m.group(1))[0].get('results') or []
print('$1')
for r in rows:
    for k,v in r.items(): print(f'  {k:20} {v}')
print()
"
}

q "HEADCOUNT (distinct install ids)" "SELECT
  COUNT(DISTINCT CASE WHEN ci = 0 AND received_at >= (unixepoch() -  7 * 86400) * 1000 THEN install_id END) AS humans_7d,
  COUNT(DISTINCT CASE WHEN ci = 1 AND received_at >= (unixepoch() -  7 * 86400) * 1000 THEN install_id END) AS ci_ids_7d,
  COUNT(DISTINCT CASE WHEN ci = 0 AND received_at >= (unixepoch() - 30 * 86400) * 1000 THEN install_id END) AS humans_30d,
  COUNT(DISTINCT CASE WHEN ci = 1 AND received_at >= (unixepoch() - 30 * 86400) * 1000 THEN install_id END) AS ci_ids_30d
FROM events WHERE received_at >= (unixepoch() - 30 * 86400) * 1000;"

q "RETENTION (interactive installs, 90d)" "SELECT
  SUM(CASE WHEN active_days >= 2 THEN 1 ELSE 0 END) AS returning_humans,
  SUM(CASE WHEN active_days  = 1 THEN 1 ELSE 0 END) AS one_day_only,
  COUNT(*) AS all_humans_90d,
  ROUND(AVG(active_days), 2) AS avg_active_days
FROM (SELECT install_id, COUNT(DISTINCT day) AS active_days FROM events
      WHERE ci = 0 AND received_at >= (unixepoch() - 90 * 86400) * 1000 GROUP BY install_id);"

q "TOTALS" "SELECT count(*) AS events, count(DISTINCT install_id) AS installs,
  min(day) AS first_day, max(day) AS last_day FROM events;"
