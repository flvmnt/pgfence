/**
 * The telemetry send path.
 *
 * This is the only module that loads node:https, and it is only ever reached through a
 * dynamic import, on a run that is actually going to send something. Loading node:https
 * costs several milliseconds plus the cost of building its first TLS context, and an
 * opted-out run, a run inside the cooldown window and a run with an empty spool must all
 * pay exactly zero for a feature they are not using.
 *
 * Several details below are correctness requirements rather than style, and each one is
 * commented at the line that implements it.
 */

import { Resolver } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import type { Socket } from 'node:net';
import { URL } from 'node:url';
import { isTelemetryDebug } from './env.js';
import { parseTelemetryEvent, TELEMETRY_ENDPOINT } from './types.js';
import type { TelemetryEvent } from './types.js';

/** Total wall clock this feature may add to any run. */
export const CONNECT_BUDGET_MS = 250;

export const DEFAULT_ENDPOINT = TELEMETRY_ENDPOINT;

/** Extra slack for the awaitable path's safety net, so it can never outlive the budget
 *  by more than a rounding error even if no socket event ever fires. */
const SAFETY_NET_MS = 50;

const MAX_BODY_BYTES = 64 * 1024;

/** http is accepted only here. The hostname must be loopback, so the escape hatch that
 *  makes the send path testable can never downgrade a production endpoint. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface SendCallbacks {
  onWritten(): void;
  onFailed(): void;
}

interface RequestPlan {
  target: URL;
  body: string;
  userAgent: string;
}

function resolveEndpoint(env: NodeJS.ProcessEnv): URL | null {
  const raw = env.PGFENCE_TELEMETRY_ENDPOINT ?? DEFAULT_ENDPOINT;
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    // A malformed override disables sending rather than guessing at what was meant.
    return null;
  }
  if (target.protocol === 'https:') return target;
  if (target.protocol === 'http:' && LOOPBACK_HOSTS.has(target.hostname)) return target;
  return null;
}

/**
 * Build the request, validating the payload one final time on the way out.
 *
 * Every event is re-projected by parseTelemetryEvent here as well as when it was read
 * off the spool, so the bytes that reach the socket are validated by the same function
 * that validated them on the way in, with no path between the two.
 */
function planRequest(events: readonly TelemetryEvent[], env: NodeJS.ProcessEnv): RequestPlan | null {
  const target = resolveEndpoint(env);
  if (target === null) return null;

  const validated = events
    .map((event) => parseTelemetryEvent(event))
    .filter((event): event is TelemetryEvent => event !== null);
  if (validated.length === 0) return null;

  const body = JSON.stringify({ v: 1, events: validated });
  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return null;

  // The version was validated against the semver vocabulary, so this cannot put a
  // caller-controlled string, or a newline, into a header.
  return { target, body, userAgent: `pgfence/${validated[0].version}` };
}

/**
 * PGFENCE_TELEMETRY_DEBUG=1 prints the exact request to stderr and sends nothing, without
 * draining the queue or advancing the retry timer. It is what lets a skeptical reviewer
 * verify every claim in docs/telemetry.md with one command instead of reading source. It
 * is a verification aid, not an opt-out: the run still records its own event locally.
 */
function debugDump(plan: RequestPlan): void {
  process.stderr.write(`[pgfence telemetry] POST ${plan.target.href}\n${plan.body}\n`);
}

/**
 * Print what these events would have been sent as, and send nothing.
 *
 * The interactive path never opens a socket for the event it just built, so without this
 * `PGFENCE_TELEMETRY_DEBUG=1 pgfence analyze ...` could only ever print a backlog from
 * earlier runs, which on a fresh machine is empty. A reviewer running the one command the
 * docs give them would have seen no output at all and concluded the docs were wrong.
 */
export function debugDumpEvents(
  events: readonly TelemetryEvent[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    if (!isTelemetryDebug(env)) return;
    const plan = planRequest(events, env);
    if (plan === null) return;
    debugDump(plan);
  } catch {
    // A diagnostic that cannot be printed is never a reason to fail the user's run, and
    // this function is called from the same paths that must not throw.
  }
}

/**
 * A name resolver that cannot outlive the connect budget.
 *
 * The socket timeout bounds connect and transfer, but it cannot bound name resolution:
 * dns.lookup is a getaddrinfo call on the libuv threadpool, and a libuv request is not a
 * handle, so neither socket.unref() nor req.destroy() can cancel one. Against a resolver
 * that black-holes queries the CLI would stay alive until the OS gave up, which on a
 * half-connected VPN is seconds of a hung shell prompt for a feature nobody asked to wait
 * for. c-ares queries, unlike getaddrinfo, carry their own timeout and can be cancelled.
 *
 * Returns null for a literal address and for loopback names, which keep the default
 * resolution path: c-ares does not read /etc/hosts, and loopback is the seam the send path
 * is tested against. A failure to resolve is never an error the user sees, it is one more
 * "not delivered, try again later".
 */
function boundedResolver(hostname: string): Resolver | null {
  if (isIP(hostname) !== 0) return null;
  if (LOOPBACK_HOSTS.has(hostname)) return null;
  try {
    return new Resolver({ timeout: CONNECT_BUDGET_MS, tries: 1 });
  } catch {
    // A runtime without c-ares falls back to the default resolution path, which is the
    // behavior this improves on and never worse than it.
    return null;
  }
}

function fire(plan: RequestPlan, unrefSocket: boolean, settle: (written: boolean) => void): void {
  const { target, body, userAgent } = plan;
  const resolver = boundedResolver(target.hostname);

  const done = (written: boolean): void => {
    if (resolver !== null) {
      try {
        // Drops any query still in flight, so a resolver that never answers cannot hold
        // the process open past the budget.
        resolver.cancel();
      } catch {
        // cancel() with nothing pending is a no-op, and a failure to cancel is not worth
        // an exception raised from inside a socket event handler, which would crash the
        // CLI over a diagnostic detail.
      }
    }
    settle(written);
  };

  const options: RequestOptions = {
    hostname: target.hostname,
    port: target.port.length > 0 ? Number(target.port) : undefined,
    path: `${target.pathname}${target.search}`,
    method: 'POST',
    // `timeout` as an OPTION, never req.setTimeout(). The option applies
    // socket.setTimeout BEFORE connect and therefore bounds the connect phase; the
    // method only arms once a socket is connected and does not bound connect at all.
    // Against an address that drops SYN, the option fires at about 252ms while the
    // idiomatic-looking method would leave the process alive for tens of seconds.
    timeout: CONNECT_BUDGET_MS,
    // Since Node 19 the global agents set keepAlive, which would hold an idle socket,
    // and the process, open after a successful response. agent: false builds a fresh
    // default agent with keepAlive off.
    agent: false,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body, 'utf8'),
      'user-agent': userAgent,
    },
  };

  if (resolver !== null) {
    // Contextually typed by RequestOptions, and forwarded to the socket because the
    // request builds its own agent. Honors options.all, which Node 20 asks for whenever
    // autoSelectFamily is on.
    options.lookup = (hostname, lookupOptions, callback): void => {
      const respond = (addresses: string[], family: 4 | 6): void => {
        if (lookupOptions.all === true) {
          callback(null, addresses.map((address) => ({ address, family })));
        } else {
          callback(null, addresses[0], family);
        }
      };
      const fail = (err: NodeJS.ErrnoException | null): void => {
        callback(err ?? new Error('telemetry endpoint did not resolve'), '', 4);
      };
      try {
        if (lookupOptions.family === 6) {
          resolver.resolve6(hostname, (err, addresses) => {
            if (err === null && addresses.length > 0) respond(addresses, 6);
            else fail(err);
          });
          return;
        }
        resolver.resolve4(hostname, (err4, addresses4) => {
          if (err4 === null && addresses4.length > 0) {
            respond(addresses4, 4);
            return;
          }
          if (lookupOptions.family === 4) {
            fail(err4);
            return;
          }
          resolver.resolve6(hostname, (err6, addresses6) => {
            if (err6 === null && addresses6.length > 0) respond(addresses6, 6);
            else fail(err6 ?? err4);
          });
        });
      } catch (err) {
        // Reported through the callback rather than thrown: this runs inside the socket's
        // connect path, where an exception would escape as an uncaught error.
        fail(err instanceof Error ? err : null);
      }
    };
  }

  const onResponse = (res: IncomingMessage): void => {
    res.resume();
  };
  const req = target.protocol === 'https:'
    ? httpsRequest(options, onResponse)
    : httpRequest(options, onResponse);

  req.on('socket', (socket: Socket) => {
    if (unrefSocket) {
      // Frees the event loop once the socket is connected. It does NOT cover the connect
      // itself: an in-flight connect is a libuv request, not a handle, so ref/unref does
      // not apply to it. That is what the timeout option above is for, and why deleting
      // it in the belief that unref() is sufficient would ship a multi-second worst case.
      socket.unref();
      return;
    }
    // The awaitable path keeps the socket ref'd until the bytes are out, because in CI
    // that is the whole point. Once they are, the response is ignored by design, so a
    // socket left ref'd waiting for a reply nobody reads would keep a finished job alive
    // for another full budget. 'socket' always precedes 'finish', because the request
    // buffers its body until a socket exists.
    req.once('finish', () => socket.unref());
  });

  // The commit point is 'finish', not the response. With an unref'd socket the response
  // frequently never arrives before the CLI exits, even against a loopback server, while
  // a client that exits from inside the 'finish' handler still delivers the full body.
  // 'finish' cannot fire on a black-holed connect because there is no socket to flush
  // to, so the semantics are exactly right: bytes on the wire means commit, nothing sent
  // means retry later.
  req.on('finish', () => done(true));
  req.on('timeout', () => {
    req.destroy();
    done(false);
  });
  // Mandatory. Without it Node promotes a network error to an unhandled 'error' event
  // and crashes the CLI, turning a clean exit 0 into a crash. DNS failure, refused
  // connection, TLS error, corporate proxy refusal and MITM certificate rejection all
  // land here and must all be swallowed.
  req.on('error', () => done(false));
  req.end(body);
}

/**
 * Fire and return immediately. Never throws, never returns a promise.
 *
 * Used on the interactive path, where the events being sent were queued by earlier runs
 * and a failure costs nothing but reporting latency: the batch stays spooled and a later
 * run retries it.
 */
export function sendEvents(
  events: readonly TelemetryEvent[],
  callbacks: SendCallbacks,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const plan = planRequest(events, env);
    if (plan === null) return;
    if (isTelemetryDebug(env)) {
      debugDump(plan);
      return;
    }

    let settled = false;
    const settle = (written: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        if (written) callbacks.onWritten();
        else callbacks.onFailed();
      } catch {
        // The callbacks do synchronous bookkeeping on the spool. A failure there is not
        // worth an uncaught exception raised from inside a socket event handler, which
        // WOULD crash the CLI. The worst case is a batch delivered twice, and the
        // receiver dedupes on eventId precisely so that is harmless.
      }
    };

    fire(plan, true, settle);
  } catch {
    // Never throws, by contract. A send that could not even be constructed is a send
    // that did not happen, and the batch is still on disk for a later run.
  }
}

/**
 * Same request, but resolves when the body is on the socket, the budget expires, or it
 * fails. Used only on the CI path, where there is no later run to retry from.
 *
 * Resolves true when bytes reached the socket. Never rejects.
 */
export function sendEventsAwaitable(
  events: readonly TelemetryEvent[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let safetyNet: NodeJS.Timeout | undefined;
    const settle = (written: boolean): void => {
      if (settled) return;
      settled = true;
      if (safetyNet !== undefined) clearTimeout(safetyNet);
      resolve(written);
    };

    try {
      const plan = planRequest(events, env);
      if (plan === null) {
        settle(false);
        return;
      }
      if (isTelemetryDebug(env)) {
        debugDump(plan);
        settle(false);
        return;
      }

      // Bounds the whole call even if no socket event ever fires, so telemetry can never
      // outlive the connect budget in a CI job. Deliberately NOT unref'd: this promise is
      // awaited, and the reporter output and the --ci gate sit after that await. An
      // unref'd timer that was ever the only thing pending would let Node exit 0 without
      // resuming the awaiting function, which here means a risky migration printing
      // nothing and exiting 0 instead of 1. settle() clears it, so a ref'd timer can
      // never extend the process either.
      safetyNet = setTimeout(() => settle(false), CONNECT_BUDGET_MS + SAFETY_NET_MS);

      // Deliberately does NOT unref the socket before 'finish': in CI the whole point is
      // to get the bytes out before the process exits.
      fire(plan, false, settle);
    } catch {
      // Never rejects, by contract. A CI event that cannot be sent is simply lost, which
      // is acceptable: CI numbers are a run count, not a headcount. Routed through settle
      // so the safety net is cleared with it.
      settle(false);
    }
  });
}
