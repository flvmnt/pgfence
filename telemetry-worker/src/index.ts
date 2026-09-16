/**
 * pgfence telemetry receiver.
 *
 * One route, one table. POST /v1/event takes { "v": 1, "events": [ ... ] } and writes
 * validated rows into D1. Everything else gets a status code and nothing else.
 *
 * What this Worker deliberately never reads:
 *   CF-Connecting-IP, X-Forwarded-For, X-Real-IP, True-Client-IP, request.cf,
 *   the user-agent header, cookies, or any other header beyond content-length.
 * There is no column in the schema that could hold an address or a geography, so this
 * is not a policy that can drift: there is nowhere to put one.
 *
 * The response is always empty. The client commits its batch when the request body
 * reaches the socket and ignores the response entirely, so there is nothing useful to
 * return, and returning nothing tells a scanner nothing about the infrastructure.
 */

import { validateEnvelope } from './validate.js';

interface Env {
  DB: D1Database;
}

const MAX_BODY_BYTES = 64 * 1024;

/** Rows older than this are deleted by the scheduled handler. Keep this number in sync
 *  with the retention figure stated in docs/telemetry.md and on pgfence.com/telemetry. */
const RETENTION_DAYS = 400;

const INSERT_SQL =
  'INSERT OR IGNORE INTO events (' +
  'event_id, received_at, day, client_ts, install_id, fresh_install_id, command, version, ' +
  'node_major, os, ci, ci_provider, tty, format, rules_mode, plugin_count, file_count_bucket, ' +
  'find_safe, find_low, find_medium, find_high, find_critical, policy_errors, policy_warnings, ' +
  'errored, duration_ms' +
  ') VALUES (' +
  '?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26)';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/v1/event') return new Response(null, { status: 404 });
    if (request.method !== 'POST') return new Response(null, { status: 405 });

    const declared = Number(request.headers.get('content-length') ?? '0');
    if (!Number.isFinite(declared) || declared > MAX_BODY_BYTES) {
      return new Response(null, { status: 413 });
    }

    let body: unknown;
    try {
      const text = await request.text();
      // content-length can lie, so the real length is checked again after reading.
      if (text.length > MAX_BODY_BYTES) return new Response(null, { status: 413 });
      body = JSON.parse(text) as unknown;
    } catch {
      // A malformed body is a client bug or a scanner. Answer 400 and record nothing.
      // Swallowing is correct: there is no caller to propagate to and no state to undo.
      return new Response(null, { status: 400 });
    }

    const events = validateEnvelope(body);
    if (events.length === 0) return new Response(null, { status: 400 });

    const receivedAt = Date.now();
    const day = new Date(receivedAt).toISOString().slice(0, 10);
    const stmt = env.DB.prepare(INSERT_SQL);

    try {
      await env.DB.batch(
        events.map((e) =>
          stmt.bind(
            e.eventId,
            receivedAt,
            day,
            e.ts,
            e.installId,
            e.freshInstallId ? 1 : 0,
            e.command,
            e.version,
            e.nodeMajor,
            e.os,
            e.ci ? 1 : 0,
            e.ciProvider,
            e.tty ? 1 : 0,
            e.format,
            e.rulesMode,
            e.pluginCount,
            e.fileCountBucket,
            e.findSafe,
            e.findLow,
            e.findMedium,
            e.findHigh,
            e.findCritical,
            e.policyErrors,
            e.policyWarnings,
            e.errored ? 1 : 0,
            e.durationMs,
          ),
        ),
      );
    } catch {
      // A database error must not be reported to the client as a failure. The client
      // would back off and retry a batch it has already delivered, and a retry storm
      // aimed at a database that is already unhappy makes the outage worse. Answer 204
      // and drop the batch: losing a few counts is cheaper than amplifying an incident.
      return new Response(null, { status: 204 });
    }

    return new Response(null, { status: 204 });
  },

  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    await env.DB.prepare('DELETE FROM events WHERE received_at < ?1').bind(cutoff).run();
  },
};
