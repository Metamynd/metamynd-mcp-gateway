// The remote gateway (docs/design.md §7, phase 3): the same governed MCP server, served over Streamable HTTP for AI
// apps that can't start a local process, such as Grok Bot's Remote HTTPS connectors and hosted chat products. It runs
// on the customer's own server, never MetaMynd's (decision 3). Governance is unchanged: each request gets a fresh MCP
// server from createGatewayServer, over the same governance (every call decided at the gate).
//
// What this file adds is the front door (threat T9):
//   - a bearer token per installation is required on every MCP request (src/tokens.mjs); without one, nothing is parsed;
//   - a body-size limit, checked before anything is parsed;
//   - a rate limit per token, and a cap on failed sign-ins per client address;
//   - browsers are refused unless their Origin is listed (DNS rebinding);
//   - TLS in this process, or explicitly behind a TLS proxy. The CLI refuses plain HTTP on a non-loopback address
//     otherwise (see listenProblem).
// The client's address is the socket's. Forwarded-for headers are never trusted: anyone can send them.

import http from 'node:http';
import https from 'node:https';
import { Readable, pipeline } from 'node:stream';
import { createMcpHandler } from '@modelcontextprotocol/server';

export const MCP_PATH = '/mcp';
export const DEFAULT_LIMITS = Object.freeze({
  /** Largest request body accepted, in bytes. MCP tool calls are small; 1 MiB is generous. */
  maxBodyBytes: 1024 * 1024,
  /** MCP requests per token per minute. */
  requestsPerMinute: 120,
  /** Failed sign-ins per client address per minute before answers become 429 (and 50 times that from all addresses). */
  failedAuthPerMinute: 20,
  /** Requests open at once per token; a long-lived stream counts until it closes. */
  concurrentPerToken: 16,
});

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Why the gateway must not listen as asked, or null. Plain HTTP is allowed only on a loopback address (for local testing)
 * or when the operator says a TLS-terminating proxy is in front.
 * @param {{ host: string, tls?: unknown, behindTlsProxy?: boolean }} o
 */
export function listenProblem({ host, tls, behindTlsProxy }) {
  if (tls || behindTlsProxy || LOOPBACK.has(host)) return null;
  return `refusing to serve plain HTTP on ${host}: tokens and tool results would cross the network unencrypted. Pass --tls-cert and --tls-key, or --behind-tls-proxy if a TLS-terminating proxy is in front, or listen on 127.0.0.1`;
}

/**
 * A fixed-window counter per key: `hit(key)` returns true while the key is within its limit for this minute. At most
 * `maxKeys` keys are tracked. Past that, the oldest key is dropped (a Map keeps insertion order), so an attacker
 * rotating addresses costs constant memory and time per request.
 */
export function windowCounter(/** @type {number} */ limit, now = () => Date.now(), maxKeys = 10_000) {
  /** @type {Map<string, { start: number, n: number }>} */
  const windows = new Map();
  return {
    /** @param {string} key */
    hit(key) {
      const t = now();
      let w = windows.get(key);
      if (!w || t - w.start >= 60_000) {
        windows.delete(key); // re-inserted below, so insertion order stays oldest-first
        while (windows.size >= maxKeys) windows.delete(/** @type {string} */ (windows.keys().next().value));
        w = { start: t, n: 0 };
        windows.set(key, w);
      }
      w.n += 1;
      return w.n <= limit;
    },
    /** Seconds until the key's window resets (for Retry-After). */
    retryAfter(/** @type {string} */ key) {
      const w = windows.get(key);
      return w ? Math.max(1, Math.ceil((60_000 - (now() - w.start)) / 1000)) : 1;
    },
  };
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} message
 * @param {Record<string, string>} [headers]
 */
function plain(res, status, message, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify({ error: message }));
}

/** Request headers never passed further in: credentials, and framing that no longer matches the re-read body. */
const DROPPED_HEADERS = new Set(['authorization', 'cookie', 'host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'expect']);
/** The base of the URL handed to the MCP handler: fixed, never the client's Host header. */
const INNER_BASE = 'http://gateway.invalid';

/**
 * Read the body, stopping as soon as it passes the limit.
 * @param {http.IncomingMessage} req
 * @param {number} max
 * @returns {Promise<Buffer | null>} null when it is too large
 */
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) { resolve(null); return; }
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (/** @type {Buffer} */ c) => {
      size += c.length;
      if (size > max) { req.removeAllListeners('data'); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(size > max ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * The HTTP request listener.
 * @param {{
 *   makeServer: () => import('@modelcontextprotocol/server').Server,
 *   verifier: { verify(presented: string | undefined): Promise<{ id: string } | null> },
 *   limits?: Partial<typeof DEFAULT_LIMITS>,
 *   allowedOrigins?: string[],
 *   log?: (entry: Record<string, unknown>) => void,
 * }} deps
 */
export function createHttpListener({ makeServer, verifier, limits = {}, allowedOrigins = [], log = () => {} }) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const perToken = windowCounter(lim.requestsPerMinute);
  const failures = windowCounter(lim.failedAuthPerMinute);
  // All failed sign-ins together, whatever their address: behind a proxy every client shares one address, and a
  // rotating attacker has many. Valid tokens are never held back by it.
  const allFailures = windowCounter(lim.failedAuthPerMinute * 50);
  /** Requests in flight per token (an open stream counts until it closes). */
  const inFlight = new Map();
  const origins = new Set(allowedOrigins);
  const handler = createMcpHandler(() => makeServer(), {
    maxRequestBodySize: lim.maxBodyBytes,
    onerror: (err) => log({ event: 'http-error', message: err.message }),
  });

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function listener(req, res) {
    const url = new URL(req.url ?? '/', INNER_BASE);
    if (url.pathname === '/healthz' && req.method === 'GET') { plain(res, 200, 'ok'); return; }
    if (url.pathname !== MCP_PATH) { plain(res, 404, 'not found'); return; }

    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) { plain(res, 403, 'origin not allowed'); return; }

    const address = req.socket.remoteAddress ?? 'unknown';
    const auth = req.headers.authorization;
    const presented = typeof auth === 'string' && /^Bearer [^\s]+$/.test(auth) ? auth.slice(7) : undefined;
    const entry = await verifier.verify(presented);
    if (!entry) {
      const key = `ip:${address}`;
      log({ event: 'http-auth-refused', address, reason: presented ? 'unknown or revoked token' : 'no token' });
      if (!failures.hit(key) || !allFailures.hit('all')) { plain(res, 429, 'too many failed sign-ins', { 'retry-after': String(failures.retryAfter(key)), connection: 'close' }); return; }
      plain(res, 401, 'a valid access token is required', { 'www-authenticate': 'Bearer realm="metamynd-mcp-gateway"', connection: 'close' });
      return;
    }
    const tokenKey = `tok:${entry.id}`;
    if (!perToken.hit(tokenKey)) { plain(res, 429, 'rate limit reached', { 'retry-after': String(perToken.retryAfter(tokenKey)) }); return; }
    const open = inFlight.get(entry.id) ?? 0;
    if (open >= lim.concurrentPerToken) { plain(res, 429, 'too many open requests for this token', { 'retry-after': '1' }); return; }
    inFlight.set(entry.id, open + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const n = (inFlight.get(entry.id) ?? 1) - 1;
      if (n > 0) inFlight.set(entry.id, n); else inFlight.delete(entry.id);
    };
    res.on('close', release);

    /** @type {Buffer | undefined} */
    let body;
    if (req.method === 'POST') {
      const read = await readBody(req, lim.maxBodyBytes);
      if (read === null) {
        // Answer and hang up: don't keep reading what the client is still sending.
        plain(res, 413, `the request is larger than ${lim.maxBodyBytes} bytes`, { connection: 'close' });
        res.on('finish', () => req.socket.destroy());
        return;
      }
      body = read;
    }

    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || DROPPED_HEADERS.has(k)) continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    const request = new Request(new URL(url.pathname + url.search, INNER_BASE), {
      method: req.method,
      headers,
      body: body && body.length ? body.toString('utf8') : undefined, // MCP bodies are UTF-8 JSON
      signal: abort.signal,
    });
    const response = await handler.fetch(request);
    /** @type {Record<string, string>} */
    const out = { 'cache-control': 'no-store' };
    response.headers.forEach((v, k) => { out[k] = v; });
    res.writeHead(response.status, out);
    if (!response.body) { res.end(); return; }
    // A client that hangs up mid-stream errors the stream; pipeline handles that, so it can never crash the process.
    pipeline(Readable.fromWeb(/** @type {any} */ (response.body)), res, (err) => {
      if (err && err.name !== 'AbortError' && /** @type {NodeJS.ErrnoException} */ (err).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        log({ event: 'http-error', message: err.message });
      }
    });
  }

  return Object.assign(
    /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
    (req, res) => {
      listener(req, res).catch((err) => {
        log({ event: 'http-error', message: err instanceof Error ? err.message : String(err) });
        if (!res.headersSent) plain(res, 500, 'internal error');
        else res.destroy();
      });
    },
    { close: () => handler.close() },
  );
}

/**
 * Start listening. Resolves once the port is bound.
 * @param {ReturnType<typeof createHttpListener>} listener
 * @param {{ host: string, port: number, tls?: { cert: string | Buffer, key: string | Buffer } }} o
 */
export function listen(listener, { host, port, tls }) {
  const server = tls ? https.createServer({ cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2' }, listener) : http.createServer(listener);
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 100;
  server.maxConnections = 1_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(server); });
  });
}
