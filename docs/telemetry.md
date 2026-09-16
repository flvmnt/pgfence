# Anonymous telemetry

pgfence 0.8.0 and later send an anonymous usage count. This page is the complete
description of it: every field, a real payload, where it goes, what is never collected,
and how to turn it off.

## Why this exists

One question, and only one:

> How many real humans use pgfence, as opposed to CI runners and registry mirrors?

npm download counts cannot answer it. Most of them are Docker layer caches, CI installs
and registry mirrors. GitHub stars cannot answer it either. Registry mirrors are ruled
out for free, because a mirror downloads the tarball and never executes the binary, so
receiving any event at all already excludes every mirror and every layer cache. What is
left is separating humans from CI runners, which is what the `ci`, `ciProvider`, `tty`
and `freshInstallId` fields below do.

Every field exists to answer that question and carries its own justification in the
table. Several genuinely useful fields were cut because they did not, and because they
would have described your schema rather than our headcount. Those cuts are listed under
[What is never collected](#what-is-never-collected).

There is no dashboard, no funnel, no session, no cohort and no user-level analytics. The
receiver is a table queried with SQL.

## Turn it off

Any one of these is sufficient on its own. They are listed in the order pgfence checks
them.

```bash
# 1. One run, or one shell. Also accepts false, off, no. Case insensitive.
PGFENCE_TELEMETRY=0 pgfence analyze migrations/*.sql
export PGFENCE_TELEMETRY=0

# 2. Machine wide, cross vendor. Honored for any value except empty, 0 and false.
export DO_NOT_TRACK=1

# 3. This machine, persisted. Also deletes anything already queued.
pgfence telemetry disable
```

4. One repository, committed, applying to everyone on the team. Add this to
`.pgfence.toml`:

```toml
# .pgfence.toml
telemetry = false
```

or to `.pgfence.json`:

```json
{ "telemetry": false }
```

pgfence looks for that key in the directory you run it in and in every parent up to the
repository root, the directory holding `.git`. A `telemetry = false` committed at the root
of a monorepo therefore still applies when a developer, or a CI step, runs pgfence from
`packages/api`. The nearest file that actually sets `telemetry` wins. This is the only key
resolved that way: every other config key is read from the current directory only.

Telemetry is also disabled automatically, with no configuration, when `VITEST` is set to
a non-empty value or `NODE_ENV=test`, so a test suite that shells out to pgfence never
emits anything.

Deleting the state directory is a reset, **not** an opt-out:

```bash
rm -rf ~/.config/pgfence     # same thing: pgfence telemetry reset
```

That erases the install id and anything queued. The next interactive run mints a new random
install id, prints the first-run notice again, and from the run after that collection
resumes. Use it to erase what is stored, and one of the four mechanisms above to turn
collection off.

To see the current state on your machine:

```console
$ pgfence telemetry status
pgfence telemetry: enabled
  install id:   8f14e45fceea167a5a36dedd4bea2543
  state file:   /Users/you/.config/pgfence/telemetry.json
  queued:       2 events waiting to send
  endpoint:     https://telemetry.pgfence.com/v1/event
  details:      https://pgfence.com/telemetry
```

When it is off, a `reason:` line names which of the mechanisms above turned it off:

```console
$ DO_NOT_TRACK=1 pgfence telemetry status
pgfence telemetry: disabled
  reason:       DO_NOT_TRACK is set
  install id:   8f14e45fceea167a5a36dedd4bea2543
  state file:   /Users/you/.config/pgfence/telemetry.json
  queued:       2 events waiting to send
  endpoint:     https://telemetry.pgfence.com/v1/event
  details:      https://pgfence.com/telemetry
```

`pgfence telemetry status` never creates the state file and never emits an event. It
resolves every layer the collection path resolves, including your project's
`.pgfence.toml`, so a repository that sets `telemetry = false` prints "disabled" here with
`reason: telemetry = false in this project's .pgfence.toml or .pgfence.json`. Run inside a
CI job, where nothing is ever written to disk, it adds a `ci run:` line saying the event is
sent inline and no file is created.

### Precedence

First match wins.

| # | Condition | Result |
|---|---|---|
| 1 | `PGFENCE_TELEMETRY` is set to anything that is not `1`, `true`, `on` or `yes` | disabled |
| 2 | `DO_NOT_TRACK` is set to anything except empty, `0` or `false` | disabled |
| 3 | `VITEST` is non-empty, or `NODE_ENV=test` | disabled |
| 4 | `PGFENCE_TELEMETRY` is set to an on-value | enabled, skipping rules 5 and 6 |
| 5 | `telemetry = false` in the project config, in this directory or any parent up to the repository root | disabled |
| 6 | `pgfence telemetry disable` was run on this machine | disabled |
| 7 | There is no writable config directory (interactive runs only) | disabled |
| 8 | Otherwise | enabled |

Rules 1 through 5 are resolved before pgfence looks at its own state directory, so an
opted-out run never causes an install id or a state file to be created, or even read. `PGFENCE_TELEMETRY` fails closed: a value
pgfence does not recognize disables rather than enables, so a typo in an opt-out can never
silently turn collection back on.

There is deliberately no `--no-telemetry` flag. A per-command flag would have to be added
to six commands and would still miss some of them; the environment variable, the config
key and the subcommand cover every case through one code path.

## What is never collected

None of the following is collected, in any form, hashed or not:

- SQL text of any kind, including fragments, previews, hashes and normalized forms
- File paths, file names, directory names
- Table names, column names, index names, constraint names, schema names, type names
- Repository name, git remote URL, git branch, git commit
- Current working directory
- Hostname, username, user id, home directory path
- Any environment variable's value
- Database URLs, database names, hosts or ports
- Table row counts and table sizes read via `--db-url` or `--stats-file`
- Rule ids, including built-in ones, rule messages, safe rewrite text
- Lock modes, and individual risk levels per finding
- Exit codes
- IP addresses, IP-derived identifiers, geography, country or region. Nothing derived
  from your address is put in a payload, read by the receiver, or stored in the table.
  What the network layer necessarily sees is stated plainly under
  [What the receiver stores](#what-the-receiver-stores)
- MAC address, CPU model, CPU count, total memory, OS release string, architecture
- Docker or WSL detection, terminal program, shell, locale, timezone
- Session ids, and any free-form string of any origin

Three of those deserve their reasoning stated, because they are the tempting ones:

- **Rule ids.** Genuinely useful for roadmap work, and excluded anyway. A payload saying
  "this install fires `drop-table` and `alter-column-type` weekly" is a description of a
  customer's schema change posture. For a tool whose entire pitch is that it reads your
  migrations, collecting that would be unrecoverable. The `rulesMode` field answers "did
  they configure the ruleset" without it.
- **Git remote, or any project id.** This is the most cited criticism of telemetry in
  comparable developer tools, and it makes any claim of anonymity falsifiable by pointing
  at one line of source. There is no project-level question in scope. Excluded permanently.
- **Exit code.** It leaks whether a given install's migrations are dangerous. The single
  bit we need is `errored`, which says the tool crashed, and is not the same thing as the
  CI gate result.

### How that is enforced, structurally

Intent is not a guarantee, so four mechanisms enforce it:

1. **A closed vocabulary.** Every value in a payload is a number, a boolean, or a string
   drawn from a list enumerated in one file,
   [`src/telemetry/types.ts`](https://github.com/flvmnt/pgfence/blob/main/src/telemetry/types.ts).
   The only strings on the wire are `eventId` (a uuid this process generated), `installId`
   (32 hex this process generated), `version` (validated against a semver pattern or
   replaced with the literal `unknown`), and members of the five vocabularies listed in
   the field table below.
2. **Re-projection, not casting.** `parseTelemetryEvent` builds a fresh object with the 25
   known keys and copies each field only after testing it against its vocabulary, its
   pattern or its numeric bounds. An extra key is dropped, not carried. It runs when an
   event is written, again when it is read back off the queue, and once more inside the
   send path immediately before serialization, so a hand-edited or future-version queued
   file cannot smuggle a field onto the wire.
3. **The import graph.** `src/telemetry/**` imports only `node:` builtins and its own four
   siblings. It never imports the analyzer, the parser, the rules, the extractors or any
   of their types, so it is structurally incapable of reading an analysis result, a check
   or a file path. The interface the CLI hands it, `TelemetryOutcome`, accepts only
   numbers, booleans and closed enums, which makes the boundary a compile error rather
   than a review comment.
4. **The receiver validates independently.** The server duplicates the vocabularies rather
   than importing the client's, and rejects anything that is not exactly the 25-key shape.
   An unknown key is a rejection, not a silent drop, because an unknown key is the only
   way a table name or a SQL fragment could ever reach the database.

Verify all of it yourself without reading the source:

```bash
PGFENCE_TELEMETRY_DEBUG=1 pgfence analyze migrations/*.sql
```

That prints to stderr the exact request that would have been made: the event this run
produced, and any queued batch this run would have delivered. It sends nothing, does not
drain the queue and does not advance the retry timer, so you can run it as many times in a
row as you like and see the same thing. It is a verification aid, not an opt-out: the run
still records its own event locally, exactly as it would have without the variable, so use
one of the mechanisms above to actually disable collection.

## Every field

25 fields. Field count, names and order are fixed by the schema version.

| Field | Type | Example | Why it is collected |
|---|---|---|---|
| `v` | `1` | `1` | Payload schema version. Lets the receiver reject or migrate old clients instead of guessing. It is also on the envelope. |
| `eventId` | uuid string | `"f43c9928-6c36-4b39-a16b-55627a25aae8"` | Random per event. The receiver deduplicates on it, which is what makes delivery safe when a run exits with a request in flight. |
| `installId` | 32 lowercase hex | `"8f14e45fceea167a5a36dedd4bea2543"` | Random per machine, from `randomBytes(16)`. Derived from nothing: not the hostname, not the MAC address, not the working directory, not any hash of any of them. Distinct `installId`s with `ci: false` is the headcount this whole feature exists to produce. |
| `freshInstallId` | boolean | `false` | True when the id was minted during this run rather than read from disk. A population that is almost always true is ephemeral containers, not humans. Second of three CI-versus-human signals. |
| `command` | enum | `"analyze"` | Which command ran. Tells us whether humans use anything beyond `analyze`. One of `analyze`, `trace`, `explain`, `snapshot`, `init`. |
| `version` | semver or `"unknown"` | `"0.8.0"` | pgfence's own version. Tells us how fast humans upgrade, which is what makes a headcount actionable. Validated against a semver pattern; anything else becomes the literal `unknown`. |
| `nodeMajor` | integer 0 to 999 | `20` | Node major only, never the full version. Tells us which Node majors we must keep supporting. |
| `os` | enum | `"darwin"` | Platform. Tells us whether the Windows code path is worth maintaining. One of `darwin`, `linux`, `win32`, `freebsd`, `openbsd`, `netbsd`, `sunos`, `aix`, `android`, `cygwin`, `other`. |
| `ci` | boolean | `false` | True when a known CI variable is present. This field is the literal subject of the question this feature exists to answer. |
| `ciProvider` | enum | `"none"` | Coarse CI vendor, `none` when `ci` is false. Separates one 500-job matrix from 500 different teams, which a boolean cannot. One of `none`, `github`, `gitlab`, `circle`, `travis`, `azure`, `jenkins`, `buildkite`, `teamcity`, `appveyor`, `codebuild`, `bitbucket`, `drone`, `vercel`, `netlify`, `other`. Detected by the presence of a variable; the variable's value is never read beyond present or absent, and never sent. |
| `tty` | boolean | `false` | `process.stdout.isTTY === true`. A human at a terminal, as opposed to a git hook, a pipe or a runner. Third and last CI-versus-human signal. |
| `format` | enum | `"prisma"` | Migration format detected across the run. Tells us which ORM ecosystems actually run pgfence, which decides where extractor work goes. One of `sql`, `typeorm`, `prisma`, `knex`, `drizzle`, `sequelize`, `kysely`, `mixed`, `none`. |
| `rulesMode` | enum | `"default"` | Whether the run used the stock ruleset or a customized one. Distinguishes a configured, adopted install from a drive-by run. One of `default`, `enable`, `disable`, `both`. Never which rules. |
| `pluginCount` | integer 0 to 99 | `0` | How many plugins were loaded. A nonzero value means someone invested enough to write custom rules, which is the strongest adoption signal available. Never plugin names or paths. |
| `fileCountBucket` | integer 0 to 5 | `3` | Coarse bucket of input files: `0` = 0 files, `1` = 1, `2` = 2 to 5, `3` = 6 to 20, `4` = 21 to 100, `5` = more than 100. A one-file run is a smoke test or a hook; a 40-file run is a real repository. Bucketed rather than exact because an exact count of a private repository's migration directory is a fingerprinting bit with no added value. |
| `findSafe` | integer 0 to 9999 | `4` | Findings at effective risk SAFE. |
| `findLow` | integer 0 to 9999 | `2` | Findings at effective risk LOW. |
| `findMedium` | integer 0 to 9999 | `1` | Findings at effective risk MEDIUM. |
| `findHigh` | integer 0 to 9999 | `3` | Findings at effective risk HIGH. |
| `findCritical` | integer 0 to 9999 | `0` | Findings at effective risk CRITICAL. Counts only. Effective risk is the size-adjusted one where `--db-url` or `--stats-file` escalated it, because that is the value you saw. These five tell us whether humans keep running a tool that finds nothing, which is the difference between installed and used. |
| `policyErrors` | integer 0 to 9999 | `1` | Policy violations at severity error. |
| `policyWarnings` | integer 0 to 9999 | `2` | Policy violations at severity warning. Split out from the risk counts because policy checks fire on migrations that have no schema findings at all. |
| `errored` | boolean | `false` | True when the command's error handler ran, meaning you got exit code 2. A version whose error rate jumps is a version humans abandon. This is not the CI gate result and not the exit code. |
| `durationMs` | integer, rounded to 10ms, capped at 600000 | `120` | Wall clock from handler entry to analysis complete. Separates a real repository run from a trivial one, and catches performance regressions that would drive humans away. |
| `ts` | integer, epoch ms | `1789572920182` | The client clock when the event was created. Necessary because an interactive event is delivered by a later run, sometimes days later, so the time it arrives is not the time it happened. |

## Example payloads

Both were produced by `PGFENCE_TELEMETRY_DEBUG=1` and reformatted for reading, with the
version and platform values set to what a released 0.8.0 run reports. The wire envelope is
`{"v":1,"events":[...]}`, and a batch carries up to 32 events.

An interactive run: `pgfence analyze` over 12 Prisma migration files on a developer's Mac,
with the stock ruleset.

```json
{
  "v": 1,
  "events": [
    {
      "v": 1,
      "eventId": "f43c9928-6c36-4b39-a16b-55627a25aae8",
      "installId": "8f14e45fceea167a5a36dedd4bea2543",
      "freshInstallId": false,
      "command": "analyze",
      "version": "0.8.0",
      "nodeMajor": 24,
      "os": "darwin",
      "ci": false,
      "ciProvider": "none",
      "tty": true,
      "format": "prisma",
      "rulesMode": "default",
      "pluginCount": 0,
      "fileCountBucket": 3,
      "findSafe": 4,
      "findLow": 2,
      "findMedium": 1,
      "findHigh": 3,
      "findCritical": 0,
      "policyErrors": 1,
      "policyWarnings": 2,
      "errored": false,
      "durationMs": 120,
      "ts": 1789572920182
    }
  ]
}
```

A CI run: the same command in a GitHub Actions job, over 3 TypeORM migrations, in a
repository that disables some rules.

```json
{
  "v": 1,
  "events": [
    {
      "v": 1,
      "eventId": "e8897f1d-1b7f-410c-af50-213e04ae433f",
      "installId": "ab95f3a6f857b73bb5d259f1c06f2ac6",
      "freshInstallId": true,
      "command": "analyze",
      "version": "0.8.0",
      "nodeMajor": 24,
      "os": "linux",
      "ci": true,
      "ciProvider": "github",
      "tty": false,
      "format": "typeorm",
      "rulesMode": "disable",
      "pluginCount": 0,
      "fileCountBucket": 2,
      "findSafe": 1,
      "findLow": 0,
      "findMedium": 2,
      "findHigh": 0,
      "findCritical": 0,
      "policyErrors": 0,
      "policyWarnings": 1,
      "errored": false,
      "durationMs": 340,
      "ts": 1789572830513
    }
  ]
}
```

Nothing else is in the request. There is no body beyond this, no second endpoint and no
sidecar process.

## Where it goes

```
POST https://telemetry.pgfence.com/v1/event
content-type: application/json
content-length: <byte length>
user-agent: pgfence/<version>
```

Those three headers are the whole request. No cookies, no authentication header, no
custom headers. The budget is 250ms, applied as a socket timeout that is armed before the
connect starts, so it bounds name resolution and connect alike: the endpoint's name is
resolved through a cancellable resolver, and when the budget expires that query is
cancelled rather than left to run out the operating system's own retry schedule, which on
a half-connected VPN is tens of seconds. Telemetry can never add more than the budget to a
run, and it hits that ceiling at most once per cooldown window.

The response is ignored entirely. pgfence considers the event delivered when the bytes
reach the socket, and the server answers `204 No Content` with an empty body, so there is
nothing to read. A DNS failure, a refused connection, a TLS error, a corporate proxy
rejection or a firewall that silently drops the address all resolve to "not delivered,
try again later" and never to an error, a delay beyond the budget, or a changed exit code.

`PGFENCE_TELEMETRY_ENDPOINT` overrides the destination. `https:` is accepted for any host;
`http:` is accepted only for `127.0.0.1`, `localhost` and `[::1]`, which exists so the
send path can be tested against a local server and cannot be used to downgrade the real
endpoint. A malformed override disables sending rather than guessing.

### What the receiver stores

The receiver is a Cloudflare Worker backed by a D1 (SQLite) table. It stores one row per
event: the 25 fields above, plus a server-side receive timestamp and the day derived from
it. That is the complete column list.

- It never reads `CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`, `True-Client-IP` or
  any other header beyond `content-length`, and never reads Cloudflare's request metadata.
  **No client IP address is stored, and there is no column that could hold one.** Neither
  is country, region or any other geographic value.
- The one honest caveat: the endpoint is served through Cloudflare, so Cloudflare's edge
  sees the connection's source address, exactly as any HTTPS server on the internet sees
  the address of anything that connects to it. That is a property of TCP and not something
  a configuration file can promise away, so it is stated here rather than implied away.
  What this repository does control is that nothing IP-derived is read by the Worker,
  nothing IP-derived is written to the database, there is no column that could hold one,
  Worker observability is off and no Logpush is configured.
- It never stores a user agent or raw request logs. Worker observability is disabled, so
  request logs are not retained.
- It stores no free-form text, because it rejects any payload that is not exactly the
  25-key closed-vocabulary shape.
- Rows are deleted by a scheduled job **400 days** after they are received.

The receiver's source lives in
[`telemetry-worker/`](https://github.com/flvmnt/pgfence/tree/main/telemetry-worker),
including the validation it applies and the exact schema of the table.

The endpoint is public and unauthenticated by design: there is no credential in the CLI to
steal and none to check. That means anyone can post anything to it, which is a limitation
of the data, noted below, not a risk to you.

## When events are sent

Delivery is deliberately decoupled from the run that produced the event. That is what
makes "never delay your run" and "actually deliver" compatible.

**Interactive runs** write one small JSON file into `~/.config/pgfence/spool/` and open no
socket at all. The queue holds at most 32 events, anything older than 7 days is deleted
unsent, and delivery happens at the start of a **later** run: one batched POST, at most
one network attempt per 5 minutes. When an attempt fails, the next one is an hour later,
then six hours, then once a day.

**CI runs** have no later run to deliver from, so the event is sent inline, once, bounded
by the same 250ms budget, and **nothing is written to disk anywhere**.

### Honest limitations

These are the difference between a number and a defensible number, so they are stated
here rather than buried:

- **Every count is a floor, not a total.** Events are dropped rather than delayed. A
  machine behind a firewall that silently drops the endpoint is never counted. A CI event
  whose send fails is simply lost.
- **The first run on any machine is never counted.** That run shows the notice and
  deliberately records nothing at all.
- **Non-interactive local runs are not counted until an interactive one happens.** If your
  first several runs are inside a git hook or a pipe, you never saw the notice, so nothing
  is recorded until you run pgfence in a terminal once.
- **A machine that runs pgfence once and never comes back is never counted**, because
  interactive events are delivered by a later run.
- **CI numbers are run counts, not team counts.** Ephemeral containers mint a new install
  id every run, which is exactly why `freshInstallId` exists. A 20-cell matrix is 20
  events from one team.
- **Anyone can post anything to the endpoint.** The receiver validates shape and
  vocabulary, but the data is unauthenticated. Large sudden changes should be treated as
  suspect.

## The state file

One file and one directory per machine:

```
~/.config/pgfence/telemetry.json            macOS and Linux
$XDG_CONFIG_HOME/pgfence/telemetry.json     when XDG_CONFIG_HOME is set to an absolute path
%APPDATA%\pgfence\telemetry.json            Windows
```

The queue sits next to it in `spool/`. macOS uses `~/.config` rather than
`~/Library/Application Support` on purpose: it is a path that can be printed verbatim in
documentation and removed with one command. A relative `XDG_CONFIG_HOME` is ignored in
favor of the home directory fallback, because honoring one would write the install id
inside whatever repository is being analyzed.

Contents, in full:

```json
{
  "schemaVersion": 1,
  "installId": "8f14e45fceea167a5a36dedd4bea2543",
  "enabled": true,
  "noticeShownAt": "2026-09-14T09:41:02.118Z"
}
```

`enabled` is absent until you run `pgfence telemetry enable` or `disable`. `noticeShownAt`
is absent until the first-run notice was actually displayed.

**Delete it whenever you like.**

```bash
rm -rf ~/.config/pgfence          # everything: install id, queue, retry state
pgfence telemetry reset           # the same thing, through the CLI
```

Nothing breaks. The next interactive run mints a new random install id and shows the
first-run notice again, and that run records nothing. Anything that was still queued is
gone and is never delivered. The only consequence is that our count of returning humans
treats you as a new machine.

If the directory cannot be written (read-only home, full disk, a container with no home
directory), an **interactive** run disables telemetry for itself. It does not retry, does
not warn and does not mint a per-run id, because a fresh id on every run would silently
inflate the count on exactly the locked-down machines where it would be least accurate.

A CI run is the documented exception, and it is the same exception either way: CI never
reads or writes a state file at all, so a container with no home directory changes nothing
about it. It mints an ephemeral id for that one run, reports `freshInstallId: true` and
sends inline. `pgfence telemetry status` run inside such a job reports that honestly rather
than claiming telemetry is off.

## The first-run notice

The first time pgfence runs interactively on a machine, it prints this to **stderr**, once
ever, and that run sends and records nothing at all:

```
pgfence collects anonymous usage counts so we can tell how many people use it.
Sent: a random install id, the command, pgfence/Node/OS versions, CI or not, how long the run took, and counts of findings by severity.
Never sent: SQL, file names or paths, table, column or rule names, or anything read from a database.
Opt out: PGFENCE_TELEMETRY=0, DO_NOT_TRACK=1, "pgfence telemetry disable", or telemetry = false in .pgfence.toml
Nothing was sent during this run. Full list: https://pgfence.com/telemetry
```

It goes to stderr because stdout carries `--output json`, `--output sarif`,
`--output gitlab` and `--output github`, which are piped into parsers, and a notice there
would corrupt them invisibly. It is printed only when stderr is a terminal, so a git hook,
a pipe or a CI log never sees it, and because it was not shown it stays due for the next
interactive run.

## CI behavior

- No notice is printed. CI stderr is not a terminal, and a container has no persistent
  state, so the notice would otherwise print on every job in every matrix cell forever.
- **No files are written.** Not the install id, not a queue, nothing. pgfence leaves
  nothing behind in your runner.
- One inline send per run, bounded by 250ms. If it fails, the event is lost.
- Every opt-out works identically. Setting `PGFENCE_TELEMETRY=0` once at the workflow level
  covers an entire pipeline:

```yaml
env:
  PGFENCE_TELEMETRY: '0'
```

- A persisted `pgfence telemetry disable` is still honored on a self-hosted runner or in a
  baked image, because the state file is read before anything is sent.
- `pgfence telemetry status`, run as a step inside the job, is the disclosure route for CI,
  since no notice is printed there. It reports exactly what that job would collect,
  including on an image with no home directory.

## Editors

**The pgfence language server never emits telemetry.** Not once, not on a schema, not on a
document change. `pgfence lsp` and the `pgfence-lsp` binary do not call into the telemetry
module at all, and no file under `src/lsp/` so much as mentions it. The `pgfence-lsp`
binary points straight at the server and never loads the CLI entry point, so the editor
path is covered by the absence of an import rather than by a runtime flag that could be
flipped back. The VS Code extension is a thin client over that server and adds nothing of
its own.

## Environment variables

| Variable | Effect |
|---|---|
| `PGFENCE_TELEMETRY` | `1`, `true`, `on`, `yes` enable. Anything else that is set disables. |
| `DO_NOT_TRACK` | Any value except empty, `0` and `false` disables. |
| `PGFENCE_TELEMETRY_DEBUG` | `1` prints the exact request to stderr and sends nothing. Not an opt-out. |
| `PGFENCE_TELEMETRY_ENDPOINT` | Overrides the destination. `https:` anywhere, `http:` only on loopback. |
| `XDG_CONFIG_HOME` | State directory, when set to an absolute path. |
| `APPDATA` | State directory on Windows. |

## Read the source

The whole implementation is five files and imports nothing but `node:` builtins. A
skeptical reviewer can read the first one in about a minute and see the entire payload
contract.

| File | What it is |
|---|---|
| [`src/telemetry/types.ts`](https://github.com/flvmnt/pgfence/blob/main/src/telemetry/types.ts) | The payload, the five closed vocabularies, and `parseTelemetryEvent`. Imports nothing at all. |
| [`src/telemetry/env.ts`](https://github.com/flvmnt/pgfence/blob/main/src/telemetry/env.ts) | Opt-out resolution, CI detection, state directory resolution. |
| [`src/telemetry/store.ts`](https://github.com/flvmnt/pgfence/blob/main/src/telemetry/store.ts) | The state file and the queue. |
| [`src/telemetry/post.ts`](https://github.com/flvmnt/pgfence/blob/main/src/telemetry/post.ts) | The send path, and the only place `node:https` is loaded. |
| [`src/telemetry/session.ts`](https://github.com/flvmnt/pgfence/blob/main/src/telemetry/session.ts) | Orchestration and the `pgfence telemetry` subcommand. |
| [`telemetry-worker/`](https://github.com/flvmnt/pgfence/tree/main/telemetry-worker) | The receiver: validation, schema, and the queries it answers. |

Three invariants hold throughout the implementation: telemetry never changes an exit code,
never writes to stdout outside the `pgfence telemetry` subcommand, and never throws out of
any function the CLI calls.

If you find something on this page that the code does not do, that is a bug and we want
the report: <https://github.com/flvmnt/pgfence/issues>.
