// The remote gateway over real HTTP (src/http.mjs, src/tokens.mjs): a real MCP client over Streamable HTTP ↔ the gateway
// listening on a loopback port ↔ a fake upstream, with the real guard and a fake MetaMynd API. The front door (tokens,
// limits, origins) must refuse before anything reaches governance, and governance must behave exactly as over stdio.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Server, InMemoryTransport } from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createGuard } from '@metamynd/agentsafe-guard';
import { parseConfig } from '../src/config.mjs';
import { createGatewayServer } from '../src/gateway.mjs';
import { GUARD_OPTIONS, createGovernance } from '../src/governance.mjs';
import { createHttpListener, listen, listenProblem, windowCounter } from '../src/http.mjs';
import { openJournal } from '../src/journal.mjs';
import { schemaHashOf } from '../src/schema-hash.mjs';
import { createToken, listTokens, revokeToken, tokenFile, tokenVerifier } from '../src/tokens.mjs';
import { listAllTools, reconcileTools } from '../src/upstreams.mjs';
import { installFakeGate, testAgent } from './fake-gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const realFetch = globalThis.fetch; // the fake gate replaces globalThis.fetch; the app's HTTP client must not go through it
const PAY_TOOL = { name: 'create_payment', description: 'Pay someone.', inputSchema: { type: 'object', properties: { amount: { type: 'number' }, currency: { type: 'string' }, payee: { type: 'string' } } } };

/** @type {(body: Record<string, any>) => Record<string, any>} */
let decide = () => ({ decision: 'allow', reasonCode: 'AUTHORIZED' });
/** @type {ReturnType<typeof installFakeGate>} */
let gate;
/** @type {Array<unknown>} */
let ran;
/** @type {string} */
let url;
/** @type {string} */
let stateDir;
/** @type {string} */
let goodToken;
/** @type {import('node:http').Server} */
let httpServer;
/** @type {ReturnType<typeof createHttpListener>} */
let listener;

before(async () => {
  gate = installFakeGate({ decide: (b) => decide(b) });
  ran = [];
  const upstream = new Server({ name: 'payments', version: '1.0.0' }, { capabilities: { tools: {} } });
  upstream.setRequestHandler('tools/list', async () => /** @type {any} */ ({ tools: [PAY_TOOL] }));
  upstream.setRequestHandler('tools/call', async (req) => { ran.push(req.params.arguments); return { content: [{ type: 'text', text: 'paid' }] }; });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await upstream.connect(a);
  const upstreamClient = new Client({ name: 'gateway', version: '0' });
  await upstreamClient.connect(b);

  const config = parseConfig({
    agentConfig: './agent.json',
    upstreams: { payments: { command: 'node', env: { API_KEY: '${PAY_KEY}' } } },
    tools: { 'payments.create_payment': { action: 'payment.create', amount: 'amount', currency: 'currency', merchant: 'payee', allowedArgs: ['amount', 'currency', 'payee'], schemaHash: schemaHashOf(PAY_TOOL) } },
  }, '/cfg');
  const { offered } = reconcileTools(config, new Map([['payments', await listAllTools(/** @type {any} */ (upstreamClient))]]));
  const { agentDid, agentKey } = await testAgent();
  const guard = createGuard({ api: 'http://gate.test/api/v1', agentDid, agentKey, signContext: false, ...GUARD_OPTIONS });
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'mcpgw-http-'));
  const journal = await openJournal(path.join(stateDir, 'held.json'));
  const governance = createGovernance({ guard, journal, callUpstream: (m, args) => /** @type {any} */ (upstreamClient.callTool({ name: m.tool, arguments: args })) });

  goodToken = (await createToken(tokenFile(stateDir), 'test app')).token;
  listener = createHttpListener({
    makeServer: () => createGatewayServer({ offered, governance }),
    verifier: tokenVerifier(tokenFile(stateDir)),
    limits: { maxBodyBytes: 8 * 1024, requestsPerMinute: 1000, failedAuthPerMinute: 1000 },
    allowedOrigins: ['https://allowed.example'],
  });
  httpServer = /** @type {import('node:http').Server} */ (await listen(listener, { host: '127.0.0.1', port: 0 }));
  url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (httpServer.address()).port}/mcp`;
});

after(async () => {
  gate.restore();
  await listener.close();
  await new Promise((r) => httpServer.close(r));
});

/** An AI app connected over Streamable HTTP with this token. */
async function app(/** @type {string | undefined} */ token = goodToken) {
  const client = new Client({ name: 'ai-app', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    fetch: realFetch,
    requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} },
  }));
  return client;
}

const initBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });
const post = (/** @type {Record<string, string>} */ headers, body = initBody) => realFetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
  body,
});

test('over HTTP: an allowed call runs, a refused one does not, through the same governance as stdio', async () => {
  const before = ran.length;
  decide = (b) => (b.amount > 100 ? { decision: 'block', reasonCode: 'SPEND_LIMIT_EXCEEDED' } : { decision: 'allow', reasonCode: 'AUTHORIZED' });
  const client = await app();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['payments__create_payment']);
    const ok = await client.callTool({ name: 'payments__create_payment', arguments: { amount: 40, currency: 'USD', payee: 'acme' } });
    assert.notEqual(ok.isError, true);
    const refused = await client.callTool({ name: 'payments__create_payment', arguments: { amount: 4000, currency: 'USD', payee: 'acme' } });
    assert.equal(refused.isError, true);
    assert.match(JSON.stringify(refused.content), /SPEND_LIMIT_EXCEEDED/);
    assert.deepEqual(ran.slice(before), [{ amount: 40, currency: 'USD', payee: 'acme' }]);
    assert.equal(gate.state.bundleFetches, 0, 'decided at the gate, never locally');
  } finally { await client.close(); }
});

test('over HTTP: a held call answers at once, and runs exactly once after approval', async () => {
  const before = ran.length;
  decide = () => ({ decision: 'escalate', reasonCode: 'RISK_REVIEW' });
  const args = { amount: 90, currency: 'USD', payee: 'held-co' };
  const client = await app();
  try {
    const held = await client.callTool({ name: 'payments__create_payment', arguments: args });
    assert.equal(held.isError, true);
    assert.match(JSON.stringify(held.content), /holding this call for approval/);
    assert.equal(ran.length, before);
    const escalationId = [...gate.state.escalations.keys()].at(-1);
    gate.resolve(/** @type {string} */ (escalationId), 'approved');
    const done = await client.callTool({ name: 'payments__create_payment', arguments: args });
    assert.notEqual(done.isError, true);
    assert.deepEqual(ran.slice(before), [args]);
  } finally { await client.close(); }
});

test('T9: no token, a wrong token, or a revoked token is refused before anything runs', async () => {
  const before = { ran: ran.length, asked: gate.state.authorizations.length };
  const none = await post({});
  assert.equal(none.status, 401);
  assert.match(String(none.headers.get('www-authenticate')), /^Bearer /);
  assert.equal((await post({ authorization: 'Bearer mmgw_not-a-real-token' })).status, 401);
  assert.equal((await post({ authorization: `Basic ${Buffer.from('a:b').toString('base64')}` })).status, 401);
  await assert.rejects((async () => { const c = await app(''); try { await c.listTools(); } finally { await c.close().catch(() => {}); } })(), 'an MCP client without a token gets nothing');

  const { token, entry } = await createToken(tokenFile(stateDir), 'to revoke');
  assert.equal((await post({ authorization: `Bearer ${token}` })).status, 200);
  assert.equal(await revokeToken(tokenFile(stateDir), entry.id), true);
  assert.equal((await post({ authorization: `Bearer ${token}` })).status, 401, 'revoked: refused from the next request, no restart');

  assert.equal(ran.length, before.ran);
  assert.equal(gate.state.authorizations.length, before.asked, 'nothing was even asked of MetaMynd');
});

test('a body over the limit is refused with 413, and a browser origin that is not listed with 403', async () => {
  const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(9000) } });
  assert.equal((await post({ authorization: `Bearer ${goodToken}` }, big)).status, 413);
  assert.equal((await post({ authorization: `Bearer ${goodToken}`, origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ authorization: `Bearer ${goodToken}`, origin: 'https://allowed.example' })).status, 200);
});

test('health check answers without a token and says nothing else; other paths are 404', async () => {
  const h = await realFetch(url.replace('/mcp', '/healthz'));
  assert.equal(h.status, 200);
  assert.deepEqual(await h.json(), { error: 'ok' });
  assert.equal((await realFetch(url.replace('/mcp', '/admin'))).status, 404);
});

test('the rate limit and the failed sign-in cap', async () => {
  let t = 0;
  const c = windowCounter(2, () => t);
  assert.equal(c.hit('k'), true);
  assert.equal(c.hit('k'), true);
  assert.equal(c.hit('k'), false);
  assert.equal(c.hit('other'), true, 'per key');
  t = 60_000;
  assert.equal(c.hit('k'), true, 'a new minute');

  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcpgw-rl-'));
  const { token } = await createToken(tokenFile(dir));
  const l = createHttpListener({ makeServer: () => new Server({ name: 'x', version: '0' }, { capabilities: {} }), verifier: tokenVerifier(tokenFile(dir)), limits: { requestsPerMinute: 1, failedAuthPerMinute: 1 } });
  const s = /** @type {import('node:http').Server} */ (await listen(l, { host: '127.0.0.1', port: 0 }));
  const u = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (s.address()).port}/mcp`;
  const send = (/** @type {Record<string, string>} */ h) => realFetch(u, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...h }, body: initBody });
  try {
    assert.equal((await send({ authorization: `Bearer ${token}` })).status, 200);
    const limited = await send({ authorization: `Bearer ${token}` });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal((await send({})).status, 401);
    assert.equal((await send({})).status, 429, 'repeated failures from one address');
  } finally {
    await l.close();
    await new Promise((r) => s.close(r));
  }
});

/** A gateway-shaped listener whose one tool takes `ms` to answer, for disconnect and concurrency tests. */
async function slowGateway(/** @type {number} */ ms, /** @type {Partial<import('../src/http.mjs').DEFAULT_LIMITS>} */ limits = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcpgw-slow-'));
  const { token } = await createToken(tokenFile(dir));
  const errors = /** @type {Array<Record<string, unknown>>} */ ([]);
  const l = createHttpListener({
    makeServer: () => {
      const s = new Server({ name: 'slow', version: '0' }, { capabilities: { tools: {} } });
      s.setRequestHandler('tools/list', async () => /** @type {any} */ ({ tools: [{ name: 'wait', inputSchema: { type: 'object' } }] }));
      s.setRequestHandler('tools/call', async () => { await new Promise((r) => setTimeout(r, ms)); return { content: [{ type: 'text', text: 'done' }] }; });
      return s;
    },
    verifier: tokenVerifier(tokenFile(dir)),
    limits,
    log: (e) => { if (e.event === 'http-error') errors.push(e); },
  });
  const s = /** @type {import('node:http').Server} */ (await listen(l, { host: '127.0.0.1', port: 0 }));
  const u = new URL(`http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (s.address()).port}/mcp`);
  const connect = async () => {
    const c = new Client({ name: 'ai-app', version: '0' });
    await c.connect(new StreamableHTTPClientTransport(u, { fetch: realFetch, requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    return c;
  };
  /**
   * A raw 2025-era tools/call over node:http (no MCP client), optionally hung up after `abortAfterMs`.
   * @param {number} [abortAfterMs]
   * @returns {Promise<{ status: number, text: string } | 'hung-up'>}
   */
  const rawCall = async (abortAfterMs) => {
    const http = await import('node:http');
    const body = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'wait', arguments: {} } });
    return new Promise((resolve, reject) => {
      const req = http.request(u, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25' } }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: Number(res.statusCode), text }));
      });
      req.on('error', (e) => (abortAfterMs !== undefined ? resolve('hung-up') : reject(e)));
      req.end(body);
      if (abortAfterMs !== undefined) setTimeout(() => req.destroy(), abortAfterMs);
    });
  };
  return { connect, rawCall, errors, close: async () => { await l.close(); await new Promise((r) => s.close(r)); } };
}

test('a client that hangs up mid-call does not take the gateway down, and its slot is given back', async () => {
  const g = await slowGateway(300, { concurrentPerToken: 1 });
  try {
    const started = Date.now();
    const whole = await g.rawCall();
    assert.ok(whole !== 'hung-up' && whole.status === 200 && /done/.test(whole.text), `the raw call reaches the slow tool: ${JSON.stringify(whole)}`);
    assert.ok(Date.now() - started >= 250, 'and really waits for it');

    assert.equal(await g.rawCall(50), 'hung-up');
    await new Promise((r) => setTimeout(r, 450)); // the server side finishes into the closed socket
    const after = await g.rawCall();
    assert.ok(after !== 'hung-up' && after.status === 200, 'still serving, and the one concurrent slot was released');
  } finally { await g.close(); }
});

test('at most concurrentPerToken requests open at once per token', async () => {
  const g = await slowGateway(300, { concurrentPerToken: 1 });
  try {
    const a = await g.connect();
    const b = await g.connect();
    const first = a.callTool({ name: 'wait', arguments: {} });
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(b.callTool({ name: 'wait', arguments: {} }), /429|too many open/);
    assert.notEqual((await first).isError, true);
    await a.close();
    await b.close();
  } finally { await g.close(); }
});

test('the counter tracks a bounded number of keys, dropping the oldest', () => {
  const c = windowCounter(1, () => 0, 3);
  for (const k of ['a', 'b', 'c', 'd']) assert.equal(c.hit(k), true);
  assert.equal(c.hit('a'), true, 'a was evicted, so it starts afresh');
  assert.equal(c.hit('d'), false, 'd is still tracked');
});

test('token create and revoke at the same time never lose a change', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcpgw-lock-'));
  const file = tokenFile(dir);
  const { entry } = await createToken(file, 'to revoke');
  const results = await Promise.all([revokeToken(file, entry.id), ...Array.from({ length: 8 }, (_, i) => createToken(file, `t${i}`))]);
  assert.equal(results[0], true);
  const tokens = await listTokens(file);
  assert.equal(tokens.length, 9, 'every create kept');
  assert.ok(tokens.find((t) => t.id === entry.id)?.revokedAt, 'the revocation kept');
});

test('tokens: only a hash is stored, the token is shown once, and listing never reveals it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcpgw-tok-'));
  const { token, entry } = await createToken(tokenFile(dir), 'grok bot');
  assert.match(token, /^mmgw_[A-Za-z0-9_-]{43}$/);
  const stored = await readFile(tokenFile(dir), 'utf8');
  assert.equal(stored.includes(token), false);
  assert.equal(stored.includes(token.slice(5)), false);
  assert.deepEqual((await listTokens(tokenFile(dir))).map((t) => t.id), [entry.id]);
  const v = tokenVerifier(tokenFile(dir));
  assert.equal((await v.verify(token))?.id, entry.id);
  assert.equal(await v.verify(`${token}x`), null);
  assert.equal(await v.verify(undefined), null);
  assert.equal(await revokeToken(tokenFile(dir), 'nope'), false);
});

test('listenProblem: plain HTTP only on loopback, unless TLS or a TLS proxy is in front', () => {
  assert.equal(listenProblem({ host: '127.0.0.1' }), null);
  assert.equal(listenProblem({ host: '::1' }), null);
  assert.match(String(listenProblem({ host: '0.0.0.0' })), /refusing to serve plain HTTP/);
  assert.equal(listenProblem({ host: '0.0.0.0', behindTlsProxy: true }), null);
  assert.equal(listenProblem({ host: '0.0.0.0', tls: { cert: 'c', key: 'k' } }), null);
});

test('the CLI serving --http as a real process: lists the reviewed tool, fails closed when MetaMynd is unreachable, never runs the upstream', async () => {
  const { spawn } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const { PAY_TOOL: FIXTURE_TOOL } = await import('./fixtures/upstream.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcpgw-httpserve-'));
  const state = path.join(dir, 'state');
  const ranFile = path.join(dir, 'ran.log');
  const { agentDid, agentKey } = await testAgent();
  await writeFile(path.join(dir, 'agent.metamynd.json'), JSON.stringify({ apiBase: 'http://127.0.0.1:9/api/v1', agentDid, agentKey }));
  await writeFile(path.join(dir, 'mcp-gateway.json'), JSON.stringify({
    agentConfig: './agent.metamynd.json',
    upstreams: { payments: { command: process.execPath, args: [path.join(here, 'fixtures', 'upstream.mjs'), 'serve'], env: { API_KEY: '${PAY_KEY}', RAN_FILE: '${RAN_FILE}' } } },
    tools: { 'payments.create_payment': { action: 'payment.create', amount: 'amount', currency: 'currency', merchant: 'payee', allowedArgs: ['amount', 'currency', 'payee'], schemaHash: schemaHashOf(FIXTURE_TOOL) } },
  }));
  const { token } = await createToken(tokenFile(state), 'cli test');
  const child = spawn(process.execPath, [path.join(here, '..', 'src', 'cli.mjs'), 'serve', '--http', '--port', '0', '--config', path.join(dir, 'mcp-gateway.json'), '--state-dir', state], {
    env: { ...process.env, PAY_KEY: 'test-key', RAN_FILE: ranFile },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    const readyUrl = await new Promise((resolve, reject) => {
      let err = '';
      child.stderr.on('data', (c) => {
        err += c;
        const m = /"event":"ready".*?"url":"([^"]+)"/.exec(err);
        if (m) resolve(m[1]);
      });
      child.on('exit', (code) => reject(new Error(`exited ${code}: ${err}`)));
    });
    const client = new Client({ name: 'ai-app', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(String(readyUrl)), { fetch: realFetch, requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    try {
      assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ['payments__create_payment']);
      const r = await client.callTool({ name: 'payments__create_payment', arguments: { amount: 5, currency: 'USD', payee: 'acme' } });
      assert.equal(r.isError, true);
      assert.match(JSON.stringify(r.content), /GATE_UNREACHABLE/);
      assert.equal(existsSync(ranFile), false, 'the upstream never ran the call');
    } finally { await client.close(); }
  } finally {
    child.kill();
  }
});

test('the CLI: --http refuses plain HTTP on a public address, refuses with no token, and token create/list/revoke work', async () => {
  const run = promisify(execFile);
  const cli = path.join(here, '..', 'src', 'cli.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcpgw-httpcli-'));
  const state = path.join(dir, 'state');
  const cfg = path.join(dir, 'mcp-gateway.json');
  await writeFile(cfg, '{}');
  const env = { ...process.env, MCP_GATEWAY_CONFIG: '' };

  const publicPlain = await run(process.execPath, [cli, 'serve', '--http', '--host', '0.0.0.0', '--config', cfg, '--state-dir', state], { env }).catch((e) => e);
  assert.equal(publicPlain.code, 1);
  assert.match(publicPlain.stderr, /refusing to serve plain HTTP/);

  const noToken = await run(process.execPath, [cli, 'serve', '--http', '--config', cfg, '--state-dir', state], { env }).catch((e) => e);
  assert.equal(noToken.code, 1);
  assert.match(noToken.stderr, /no access token/);

  const stdioWithHttpFlags = await run(process.execPath, [cli, 'serve', '--port', '9999', '--config', cfg, '--state-dir', state], { env }).catch((e) => e);
  assert.match(stdioWithHttpFlags.stderr, /need --http/);

  const created = await run(process.execPath, [cli, 'token', 'create', '--label', 'grok', '--state-dir', state], { env });
  const token = created.stdout.trim();
  assert.match(token, /^mmgw_/);
  const listed = await run(process.execPath, [cli, 'token', 'list', '--state-dir', state], { env });
  assert.equal(listed.stdout, '', 'the list goes to stderr and never contains a token');
  assert.equal(listed.stderr.includes(token), false);
  const id = /^([0-9a-f]{12})\s+active/m.exec(listed.stderr)?.[1];
  assert.ok(id);
  await run(process.execPath, [cli, 'token', 'revoke', String(id), '--state-dir', state], { env });
  assert.match((await run(process.execPath, [cli, 'token', 'list', '--state-dir', state], { env })).stderr, /revoked/);
});
