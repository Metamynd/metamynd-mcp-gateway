// A fake MetaMynd API as a real HTTP server, for the conformance run (conformance/run.mjs): the gateway is started by
// each framework as its own process, so the in-process fake in test/fake-gate.mjs cannot reach it. It answers the routes
// agentsafe-guard calls, with fixed rules:
//   - an amount over 100 is refused SPEND_LIMIT_EXCEEDED;
//   - payee "needs-review" is held for a person (escalate);
//   - anything else is allowed.
import crypto from 'node:crypto';
import http from 'node:http';

/** @returns {Promise<{ url: string, state: { authorizations: any[], captures: any[], voids: string[], bundleFetches: number, localReports: number }, close: () => Promise<void> }>} */
export async function startFakeGate() {
  // bundleFetches: a guard deciding locally fetches the policy bundle first; the gateway decides every call at the gate.
  const state = { authorizations: /** @type {any[]} */ ([]), captures: /** @type {any[]} */ ([]), voids: /** @type {string[]} */ ([]), bundleFetches: 0, localReports: 0 };
  const escalations = new Map();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      const p = new URL(req.url ?? '/', 'http://x').pathname;
      const reply = (/** @type {unknown} */ data, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: status < 400, data }));
      };
      let m;
      if (p.endsWith('/policy/mandate/authorize') && req.method === 'POST') {
        state.authorizations.push(body);
        if (Number(body.amount) > 100) return reply({ decision: 'block', reasonCode: 'SPEND_LIMIT_EXCEEDED', payloadDigest: body.payloadDigest ?? null }, 403);
        if (body.merchant === 'needs-review') {
          const escalationId = crypto.randomUUID();
          escalations.set(escalationId, 'pending');
          return reply({ decision: 'escalate', reasonCode: 'ESCALATION_REQUIRED', escalationId, payloadDigest: body.payloadDigest ?? null }, 403);
        }
        return reply({ decision: 'allow', reasonCode: 'ALLOWED', authorizationId: crypto.randomUUID(), payloadDigest: body.payloadDigest ?? null });
      }
      if ((m = /\/authorize\/([^/]+)\/capture$/.exec(p))) { state.captures.push({ id: m[1], amount: body.amountCharged }); return reply({ captured: true }); }
      if ((m = /\/authorize\/([^/]+)\/void$/.exec(p))) { state.voids.push(m[1]); return reply({ voided: true, reasonCode: 'HOLD_VOIDED' }); }
      if (/\/authorize\/[^/]+\/effect$/.test(p)) return reply({ outcome: 'not_started', effectState: 'authorized', claimed: false });
      if ((m = /\/escalations\/([^/]+)\/status$/.exec(p))) {
        const status = escalations.get(m[1]);
        return status ? reply({ escalationId: m[1], status, reasonCode: `ESCALATION_${status.toUpperCase()}` }) : reply({ reasonCode: 'NOT_FOUND' }, 404);
      }
      if (p.endsWith('/policy/decisions/local')) { state.localReports += 1; return reply({ recorded: true }); }
      if (/\/policy\/bundle\//.test(p)) { state.bundleFetches += 1; return reply({ reasonCode: 'NOT_FOUND' }, 404); }
      return reply({ reasonCode: 'NOT_FOUND', path: p }, 404);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { url: `http://127.0.0.1:${port}/api/v1`, state, close: () => new Promise((r) => server.close(() => r(undefined))) };
}
