// A fake MetaMynd API for tests: replaces globalThis.fetch and answers the routes agentsafe-guard calls, so the gateway is
// exercised against the REAL guard (signing, guardTool, capture/void, resume) without a network.
import crypto from 'node:crypto';

/**
 * @param {{ decide: (body: Record<string, any>) => Record<string, any> }} opts
 *   decide(authorize body) → the verdict ({ decision, reasonCode, ... }); an allow gets an authorizationId automatically.
 */
export function installFakeGate({ decide }) {
  const real = globalThis.fetch;
  const state = {
    authorizations: /** @type {Array<Record<string, any>>} */ ([]),
    captures: /** @type {Array<{ id: string, amount: number }>} */ ([]),
    voids: /** @type {string[]} */ ([]),
    escalations: /** @type {Map<string, { status: string, authorizationId?: string }>} */ (new Map()),
    resumeClaims: /** @type {string[]} */ ([]),
  };
  const reply = (/** @type {unknown} */ data, status = 200) => new Response(JSON.stringify({ success: status < 400, data }), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = /** @type {typeof fetch} */ (async (url, init = {}) => {
    const u = new URL(String(url));
    const p = u.pathname;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (p.endsWith('/policy/mandate/authorize') && init.method === 'POST') {
      state.authorizations.push(body);
      const verdict = decide(body);
      if (verdict.decision === 'allow' || verdict.decision === 'observe') verdict.authorizationId ??= crypto.randomUUID();
      if (verdict.decision === 'escalate') {
        verdict.escalationId ??= crypto.randomUUID();
        state.escalations.set(verdict.escalationId, { status: 'pending' });
      }
      return reply({ ...verdict, payloadDigest: body.payloadDigest ?? null }, verdict.decision === 'allow' || verdict.decision === 'observe' ? 200 : 403);
    }
    let m;
    if ((m = /\/authorize\/([^/]+)\/capture$/.exec(p))) { state.captures.push({ id: m[1], amount: body.amountCharged }); return reply({ captured: true }); }
    if ((m = /\/authorize\/([^/]+)\/void$/.exec(p))) { state.voids.push(m[1]); return reply({ voided: true, reasonCode: 'HOLD_VOIDED' }); }
    if (/\/authorize\/[^/]+\/effect$/.test(p)) return reply({ outcome: 'not_started', effectState: 'authorized', claimed: false });
    if ((m = /\/escalations\/([^/]+)\/status$/.exec(p))) {
      const e = state.escalations.get(m[1]);
      return e ? reply({ escalationId: m[1], reasonCode: `ESCALATION_${e.status.toUpperCase()}`, ...e }) : reply({ reasonCode: 'NOT_FOUND' }, 404);
    }
    if ((m = /\/escalations\/([^/]+)\/resume-claim$/.exec(p))) { state.resumeClaims.push(m[1]); return reply({ claimed: true }); }
    if (p.endsWith('/policy/decisions/local')) return reply({ recorded: true });
    return reply({ reasonCode: 'NOT_FOUND', path: p }, 404);
  });
  return {
    state,
    /** A person decides a held request. */
    resolve(/** @type {string} */ escalationId, /** @type {'approved'|'denied'} */ status) {
      state.escalations.set(escalationId, { status, authorizationId: status === 'approved' ? crypto.randomUUID() : undefined });
    },
    restore() { globalThis.fetch = real; },
  };
}

/** A fresh agent identity with an in-process key (tests only; the gateway warns about plaintext keys). */
export async function testAgent() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  // Not in the guard's exports map; imported by path (tests only) so the DID really embeds this key.
  const { buildHederaDid } = await import(new URL('../node_modules/@metamynd/agentsafe-guard/magp-did.mjs', import.meta.url).href);
  const agentDid = buildHederaDid('testnet', raw, '0.0.4242');
  return { agentDid, agentKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('hex') };
}
