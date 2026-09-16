# pgfence telemetry receiver

The receiver for pgfence's anonymous usage telemetry. One Cloudflare Worker, one D1
table, one route: `POST https://telemetry.pgfence.com/v1/event`.

There is no dashboard and there will not be one. The deliverable is a table you query
with SQL. Every query worth running is in [queries.sql](queries.sql).

This directory is **not** part of the npm package and is **not** compiled by the pgfence
build:

- `tsconfig.json` at the repo root sets `rootDir: "src"` and `include: ["src/**/*"]`, so
  `pnpm build` and `pnpm typecheck` never see these files.
- `pnpm lint` runs `eslint src/ tests/`, so the repo's eslint config never lints them.
- `package.json` sets `"files": ["dist", "RULES.md", ...]`, so `npm publish` never ships
  them.
- `scripts/check-public-boundaries.sh` maps each packaged `dist/` artifact back to a file
  under `src/`. Nothing here is under `src/` and nothing here produces a `dist/` artifact,
  so the check is unaffected.

The Worker has its own `wrangler` devDependency, installed inside this directory and
never added to the pgfence package's dependencies.

## What it stores

The 25 fields the CLI sends, plus a server-side `received_at` timestamp and the UTC `day`
derived from it. Every field is an integer or a string drawn from a closed vocabulary
enumerated in [src/validate.ts](src/validate.ts). The full field list, with the
justification for each one, is in `docs/telemetry.md` and at
https://pgfence.com/telemetry.

## What it does not store, and cannot

The Worker never reads `CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`,
`True-Client-IP`, `request.cf`, the user-agent header, or any other header except
`content-length`. It never derives geography, country or colo. The only inputs it reads
are the method, the pathname, `content-length` and the body.

The schema has no column that could hold an address, a hostname, a file path, a table
name, a column name, a rule id or any SQL. That is the point: this is not a policy that
can drift, because there is nowhere to put such a value even by accident.

Request logs are off (`[observability] enabled = false` in `wrangler.toml`) and Logpush is
not configured for this Worker, because Cloudflare's request logs carry the client IP.

What no configuration can promise away is the connection itself. This endpoint is served
through Cloudflare, so the edge sees the source address of whatever connects to it, exactly
as any HTTPS server on the internet does. Everything above is about what is read, derived
and stored on top of that, which is nothing.

## Validation posture

The endpoint is public and unauthenticated, so it will be probed and spammed. The
receiver's answer is to trust nothing, including the client's own idea of its field list:

- Only `POST /v1/event`. Everything else is 404 or 405, with an empty body.
- `content-length` above 64 KiB is 413, and the length is checked again after reading,
  because a declared length can lie.
- The envelope must be exactly `{ "v": 1, "events": [ ... ] }` with 1 to 32 entries. An
  extra envelope key is a rejection.
- Each event must carry **exactly** the 25 known keys. An unknown key rejects the whole
  envelope rather than being dropped. That is the property that makes it impossible for
  this database to hold a table name even if a future buggy client sent one.
- Every string is checked against its closed vocabulary or its regex. Every number must
  be an integer inside its documented bound. `client_ts` outside a 400-day window in
  either direction is rejected as a broken clock or a probe.
- Validation builds a fresh object literal field by field. Nothing is ever cast.
- Anything that fails is a 400 and is never written.

The vocabularies in `src/validate.ts` are deliberately **duplicated** from
`src/telemetry/types.ts` rather than imported. The receiver must not depend on the CLI's
build, and a server that imports the client's definition of "acceptable" is not
validating anything.

## Rate limiting, without retaining IPs

There is **no** rate limiting in the Worker code, and no IP-derived value is stored
anywhere. The body-size cap, the 32-event envelope cap and the strict schema already
bound what a single request can cost, and `event_id` is the primary key with
`INSERT OR IGNORE`, so replaying the same batch a million times writes at most the
original rows.

If volume ever makes limiting necessary, use a Cloudflare **Rate Limiting Rule**
configured in the dashboard on the `telemetry.pgfence.com` route. It runs at the edge,
before the Worker, and counts requests per client in Cloudflare's own ephemeral edge
state. Nothing about it reaches D1, so the retained data is unchanged: the table still has
no column that could hold an address.

Do not implement limiting by hashing the client IP into KV or D1. A salted hash of an IP
is still a pseudonymous identifier for a person, and a rotating salt only shortens how
long that is true. The whole claim this feature rests on is that pgfence does not know
who you are, and the cheapest way to keep that claim honest is to never read the address
in the first place.

## Deploy in under five minutes

From this directory:

```bash
# 1. Install the Worker toolchain (local to this directory).
npm install

# 2. Authenticate. Opens a browser once.
npx wrangler login

# 3. Create the database. This prints a database_id.
npx wrangler d1 create pgfence-telemetry

# 4. Paste that id into wrangler.toml, replacing REPLACE_WITH_ID_FROM_wrangler_d1_create.

# 5. Apply the schema to the remote database.
npx wrangler d1 execute pgfence-telemetry --remote --file=./schema.sql

# 6. Deploy.
npx wrangler deploy
```

### DNS for telemetry.pgfence.com

`wrangler.toml` declares the route as a custom domain:

```toml
[[routes]]
pattern = "telemetry.pgfence.com"
custom_domain = true
```

When `pgfence.com` is already on Cloudflare, `wrangler deploy` creates the proxied DNS
record for `telemetry` itself on first deploy. Nothing else is needed. If the deploy
reports that the zone is not on this account, add `telemetry.pgfence.com` manually under
**Workers and Pages > pgfence-telemetry > Settings > Domains and Routes > Add Custom
Domain**, which creates the same proxied record. Do not create a grey-cloud (DNS-only)
record: the Worker only answers on proxied traffic.

### Smoke test before the CLI ships

A client that posts into the void looks exactly like a client that works, because the
spool hides the failure behind a backoff. Confirm one real row lands first:

```bash
curl -i -X POST https://telemetry.pgfence.com/v1/event \
  -H 'content-type: application/json' \
  -d '{"v":1,"events":[{"v":1,"eventId":"00000000-0000-4000-8000-000000000001",
"installId":"00000000000000000000000000000001","freshInstallId":true,"command":"analyze",
"version":"0.8.0","nodeMajor":22,"os":"darwin","ci":false,"ciProvider":"none","tty":true,
"format":"sql","rulesMode":"default","pluginCount":0,"fileCountBucket":2,"findSafe":1,
"findLow":0,"findMedium":0,"findHigh":0,"findCritical":0,"policyErrors":0,
"policyWarnings":0,"errored":false,"durationMs":40,"ts":'"$(($(date +%s) * 1000))"'}]}'
# expect: HTTP/2 204

npx wrangler d1 execute pgfence-telemetry --remote \
  --command "SELECT event_id, day, command, ci FROM events ORDER BY received_at DESC LIMIT 1"
```

Then delete the smoke-test row so it never pollutes a count:

```bash
npx wrangler d1 execute pgfence-telemetry --remote \
  --command "DELETE FROM events WHERE install_id = '00000000000000000000000000000001'"
```

Two rejection checks worth running once, since the whole posture rests on them:

```bash
# An unknown field rejects the envelope. Expect 400, and nothing written.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://telemetry.pgfence.com/v1/event \
  -H 'content-type: application/json' \
  -d '{"v":1,"events":[{"tableName":"users"}]}'

# Anything that is not POST /v1/event is 404 or 405.
curl -s -o /dev/null -w '%{http_code}\n' https://telemetry.pgfence.com/
```

## Running the queries

```bash
npx wrangler d1 execute pgfence-telemetry --remote --command "<one statement from queries.sql>"
```

`--command` takes a single statement. Copy one query at a time out of
[queries.sql](queries.sql); do not pipe the whole file, because it ends with the
retention `DELETE`.

The queries, in the order they answer the question:

| Query | Answers |
|---|---|
| Q1 | Distinct install ids over 7 and 30 days, interactive versus CI. The headcount. |
| Q2 | Human runs versus CI runs, and runs per human, over 30 days. |
| Q3 | Interactive installs that came back on two or more distinct days. The number this feature exists to produce. |
| Q4 | The same retention question as a histogram of active days. |
| Q5 | Weekday versus weekend ratio for interactive runs, per-day normalized. The direct test of the mirror hypothesis. |
| Q6 | Runs per day of week, as a sanity check on Q5. |
| Q7 | ORM formats by distinct install, not by run count. |
| Q8 | Fraction of runs that hit the CLI's catch block. |
| Q9 | Error rate by version and command, for pinning a regression to a release. |
| Q10 | Findings per run by file-count bucket: real migrations or toy files. |
| Q11 | Findings-per-run histogram. |
| Q12 | Share of CI install ids minted that run, which proves whether CI ids are containers. |
| Q13 | Which commands humans actually run. |
| Q14 | Configured installs (custom rules or plugins) versus drive-by runs. |
| Q15 | Version adoption among humans. |
| Q16 | OS and Node major support matrix. |
| Q17 | Run duration by file-count bucket, for catching a perf regression. |
| Q18 | Delivery lag for interactive events, a health check on the client spool. |
| Q19 | Daily volume, for spotting a spike that is a probe rather than growth. |

Each query in `queries.sql` carries a one-line comment stating what a given answer would
mean for the product decision.

## Retention

**400 days.** Rows older than that are deleted by the `scheduled` handler in
`src/index.ts`, which runs daily at 04:17 UTC under the cron trigger in `wrangler.toml`
and executes exactly this statement:

```sql
DELETE FROM events WHERE received_at < (unixepoch() - 400 * 86400) * 1000;
```

The same statement is the last entry in `queries.sql` and can be run by hand to enforce
retention immediately. `RETENTION_DAYS` in `src/index.ts` is the single source of truth;
changing it means changing the number stated in `docs/telemetry.md` and on
https://pgfence.com/telemetry in the same commit. Claiming a retention window in the
public docs without shipping the query that enforces it would be dishonest, which is why
the DELETE lives here in three places a reader can check.

400 days is chosen so that a year-over-year comparison is possible exactly once, and no
longer.

## Reading the numbers honestly

- Every count is a **floor**. Interactive events are delivered opportunistically by a
  later run, so a machine that runs pgfence once and never comes back is never counted,
  and a machine behind a firewall that drops the endpoint is never counted.
- The first run on any machine is never counted: it shows the notice and records nothing.
- CI numbers are **run counts, not team counts**. Ephemeral containers mint a new install
  id per run, which is what Q12 measures.
- CI events are lost when the send fails, because there is no later run to retry from.
- Registry mirrors are invisible by construction. A mirror downloads the tarball and never
  executes the binary, so the mirror share is npm downloads minus observed runs, computed
  outside this database.
- The endpoint is unauthenticated by design. Anyone can post a well-formed event. Treat a
  sudden jump in Q19 as suspect until it is explained.
