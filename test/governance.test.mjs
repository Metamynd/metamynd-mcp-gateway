// Governance against the REAL agentsafe-guard and a fake MetaMynd API (test/fake-gate.mjs): a call is checked, asked,
// run only on allow, settled, refused or held, and a held call resumes once approved.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGuard } from '@metamynd/agentsafe-guard';
import { parseConfig } from '../src/config.mjs';
import { createGovernance } from '../src/governance.mjs';
import { openJournal } from '../src/journal.mjs';
import { installFakeGate, testAgent } from './fake-gate.mjs';

const HASH = `sha256:${'a'.repeat(64)}`;
const config = parseConfig({
  agentConfig: './agent.json',
  upstreams: { payments: { command: 'node', env: { API_KEY: '${PAY_KEY}' } } },
  tools: {
    'payments.create_payment': { action: 'payment.create', amount: 'amount', currency: 'currency', merchant: 'payee', allowedArgs: ['amount', 'currency', 'payee', 'note'], context: { riskLevel: 'medium' }, schemaHash: HASH },
    'payments.list_invoices': { action: 'records.read', allowedArgs: ['customer'], schemaHash: HASH },
    'payments.refund': { action: 'payment.refund', amount: 'amount', currency: 'currency', allowedArgs: ['amount', 'currency'], schemaHash: HASH, onToolError: 'void' },
  },
}, '/cfg');
const PAY = /** @type {any} */ (config.tools.get('payments.create_payment'));
const READ = /** @type {any} */ (config.tools.get('payments.list_invoices'));
const REFUND = /** @type {any} */ (config.tools.get('payments.refund'));

/** @type {ReturnType<typeof installFakeGate>} */ let gate;
/** @type {Array<{ tool: string, args: unknown }>} */ let upstreamCalls;
/** @type {(tool: string, args: any) => any} */ let upstreamAnswer;
/** @type {ReturnType<typeof createGovernance>} */ let governance;
let decide = (/** @type {any} */ _b) => ({ decision: 'allow', reasonCode: 'AUTHORIZED' });

beforeEach(async () => {
  gate = installFakeGate({ decide: (b) => decide(b) });
  upstreamCalls = [];
  upstreamAnswer = () => ({ content: [{ type: 'text', text: 'done' }] });
  const { agentDid, agentKey } = await testAgent();
  const guard = createGuard({ api: 'http://gate.test/api/v1', agentDid, agentKey, signContext: false });
  const journal = await openJournal(path.join(await mkdtemp(path.join(os.tmpdir(), 'mcpgw-')), 'held.json'));
  governance = createGovernance({
    guard, journal,
    callUpstream: async (m, args) => { upstreamCalls.push({ tool: m.tool, args }); return upstreamAnswer(m.tool, args); },
  });
});
afterEach(() => { gate.restore(); decide = () => ({ decision: 'allow', reasonCode: 'AUTHORIZED' }); });

test('an allowed payment runs once and its hold is captured at the amount', async () => {
  const r = await governance.call(PAY, { amount: 40, currency: 'usd', payee: 'acme', note: 'invoice 7' });
  assert.equal(r.isError, undefined);
  assert.equal(upstreamCalls.length, 1);
  const asked = gate.state.authorizations[0];
  assert.equal(asked.action, 'payment.create');
  assert.equal(asked.amount, 40);
  assert.equal(asked.currency, 'USD');
  assert.equal(asked.merchant, 'acme');
  assert.match(asked.payloadDigest, /^sha256:/, 'the decision is bound to the exact arguments');
  assert.deepEqual(gate.state.captures.map((c) => c.amount), [40]);
});

test('a read moves nothing: authorized and captured at 0', async () => {
  await governance.call(READ, { customer: 'c-1' });
  assert.equal(gate.state.authorizations[0].action, 'records.read');
  assert.equal(gate.state.authorizations[0].amount ?? 0, 0);
  assert.deepEqual(gate.state.captures.map((c) => c.amount), [0]);
});

test('a refusal never reaches the tool and explains itself to the model', async () => {
  decide = () => ({ decision: 'block', reasonCode: 'SPEND_LIMIT_EXCEEDED', hint: 'per-transaction limit is 100' });
  const r = await governance.call(PAY, { amount: 500, currency: 'USD', payee: 'acme' });
  assert.equal(r.isError, true);
  assert.match(String(r.content[0].text), /SPEND_LIMIT_EXCEEDED/);
  assert.match(String(r.content[0].text), /per-transaction limit is 100/);
  assert.equal(upstreamCalls.length, 0);
});

test('T5: arguments outside the reviewed mapping, or of the wrong type, are never sent', async () => {
  const smuggled = await governance.call(PAY, { amount: 5, currency: 'USD', payee: 'acme', fee_override: 9000 });
  assert.match(String(smuggled.content[0].text), /not allowed for this tool: fee_override/);
  const stringAmount = await governance.call(PAY, { amount: '5', currency: 'USD', payee: 'acme' });
  assert.match(String(stringAmount.content[0].text), /"amount" must be a number/);
  assert.equal(gate.state.authorizations.length, 0, 'nothing was even asked');
  assert.equal(upstreamCalls.length, 0);
});

test('a held call answers at once, then resumes once approved — same arguments, run exactly once', async () => {
  decide = () => ({ decision: 'escalate', reasonCode: 'RISK_REVIEW' });
  const args = { amount: 90, currency: 'USD', payee: 'acme' };
  const first = await governance.call(PAY, args);
  assert.match(String(first.content[0].text), /holding this call for approval/);
  assert.equal(upstreamCalls.length, 0);
  const escalationId = [...gate.state.escalations.keys()][0];

  const stillPending = await governance.call(PAY, args);
  assert.match(String(stillPending.content[0].text), /holding this call for approval/, 'pending: held again, not asked afresh');
  assert.equal(gate.state.authorizations.length, 1);

  gate.resolve(escalationId, 'approved');
  const done = await governance.call(PAY, args);
  assert.equal(done.isError, undefined);
  assert.equal(upstreamCalls.length, 1);
  assert.deepEqual(gate.state.resumeClaims, [escalationId], 'the one resume was claimed');

  decide = () => ({ decision: 'allow', reasonCode: 'AUTHORIZED' });
  await governance.call(PAY, args);
  assert.equal(gate.state.authorizations.length, 2, 'after the resume the journal entry is gone: a new call is asked afresh');
});

test('different arguments are a new request, not the held one', async () => {
  decide = () => ({ decision: 'escalate', reasonCode: 'RISK_REVIEW' });
  await governance.call(PAY, { amount: 90, currency: 'USD', payee: 'acme' });
  await governance.call(PAY, { amount: 91, currency: 'USD', payee: 'acme' });
  assert.equal(gate.state.authorizations.length, 2);
});

test('a denied hold is refused and forgotten', async () => {
  decide = () => ({ decision: 'escalate', reasonCode: 'RISK_REVIEW' });
  const args = { amount: 90, currency: 'USD', payee: 'acme' };
  await governance.call(PAY, args);
  gate.resolve([...gate.state.escalations.keys()][0], 'denied');
  const r = await governance.call(PAY, args);
  assert.equal(r.isError, true);
  assert.doesNotMatch(String(r.content[0].text), /holding/);
  assert.equal(upstreamCalls.length, 0);
});

test('a tool error keeps the hold (it may have acted), unless the mapping marks it safely retryable', async () => {
  upstreamAnswer = () => ({ content: [{ type: 'text', text: 'bank timeout' }], isError: true });
  const kept = await governance.call(PAY, { amount: 10, currency: 'USD', payee: 'acme' });
  assert.equal(kept.isError, true);
  assert.equal(gate.state.captures.length, 1, 'captured: counted against the limits');
  assert.equal(gate.state.voids.length, 0);

  const released = await governance.call(REFUND, { amount: 10, currency: 'USD' });
  assert.equal(released.isError, true);
  assert.match(String(released.content[0].text), /bank timeout/, 'the tool\'s own error reaches the model');
  assert.equal(gate.state.voids.length, 1, 'onToolError "void": released');
});

test('an upstream that rejects the call before running it (invalid params) releases the hold', async () => {
  upstreamAnswer = () => { throw Object.assign(new Error('Invalid params'), { code: -32602 }); };
  const r = await governance.call(PAY, { amount: 10, currency: 'USD', payee: 'acme' });
  assert.match(String(r.content[0].text), /refused the call before running it/);
  assert.equal(gate.state.voids.length, 1);
  assert.equal(gate.state.captures.length, 0);
});

test('T7: MetaMynd unreachable fails closed — the tool is not called', async () => {
  gate.restore();
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {typeof fetch} */ (async () => { throw new TypeError('fetch failed'); });
  try {
    const r = await governance.call(PAY, { amount: 10, currency: 'USD', payee: 'acme' });
    assert.equal(r.isError, true);
    assert.match(String(r.content[0].text), /GATE_UNREACHABLE/);
    assert.equal(upstreamCalls.length, 0);
  } finally { globalThis.fetch = real; }
});
