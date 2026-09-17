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

# The receiver is unauthenticated by necessity: an anonymous client cannot prove it is
# genuine, so anyone can POST a well-formed event. Nothing can be stolen (the schema has
# no column that could hold anything sensitive), but the counts can be inflated. These
# two queries make that visible rather than preventing it.
q "POISONING CHECK: install ids by volume (a real human is single digits/day)" "SELECT
  install_id, COUNT(*) AS events, COUNT(DISTINCT day) AS days,
  MIN(day) AS first_day, MAX(day) AS last_day
FROM events WHERE received_at >= (unixepoch() - 7 * 86400) * 1000
GROUP BY install_id ORDER BY events DESC LIMIT 5;"

q "POISONING CHECK: busiest hours (a flood shows up as one hour)" "SELECT
  strftime('%Y-%m-%d %H:00', received_at/1000, 'unixepoch') AS hour,
  COUNT(*) AS events, COUNT(DISTINCT install_id) AS installs
FROM events WHERE received_at >= (unixepoch() - 7 * 86400) * 1000
GROUP BY hour ORDER BY events DESC LIMIT 5;"
