import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, parseConfig } from '../src/config.mjs';

const HASH = `sha256:${'a'.repeat(64)}`;
const valid = () => ({
  agentConfig: './agent.metamynd.json',
  upstreams: {
    payments: { command: 'npx', args: ['-y', 'payments-mcp@1.2.3'], env: { API_KEY: 'keychain:payments-api-key' } },
    crm: { url: 'https://crm.example.com/mcp', headers: { Authorization: 'Bearer ${CRM_TOKEN}' } },
  },
  tools: {
    'payments.create_payment': {
      action: 'payment.create', amount: 'amount', currency: 'currency', merchant: 'payee',
      allowedArgs: ['amount', 'currency', 'payee', 'reference'], context: { riskLevel: 'medium' }, schemaHash: HASH,
    },
    'crm.lookup_customer': { action: 'records.read', allowedArgs: ['customerId'], schemaHash: HASH },
  },
});

/** @param {unknown} raw @returns {string[]} */
function problemsOf(raw) {
  try { parseConfig(raw, '/cfg'); return []; } catch (e) { assert.ok(e instanceof ConfigError, String(e)); return e.problems; }
}
const has = (problems, text) => assert.ok(problems.some((p) => p.includes(text)), `expected a problem containing "${text}", got:\n${problems.join('\n')}`);

test('a valid config parses: tools exposed as <upstream>__<tool>, defaults applied, paths resolved', () => {
  const cfg = parseConfig(valid(), '/cfg');
  assert.equal(cfg.tools.get('payments.create_payment')?.exposedName, 'payments__create_payment');
  assert.equal(cfg.tools.get('crm.lookup_customer')?.onToolError, 'capture');
  assert.deepEqual(cfg.tools.get('crm.lookup_customer')?.context, {});
  assert.ok(cfg.agentConfig.endsWith('agent.metamynd.json'));
});

test('decision 2: an upstream without a credential reference is refused', () => {
  const raw = valid();
  raw.upstreams.payments.env = {};
  has(problemsOf(raw), 'upstreams.payments.env: must carry the server\'s credential as a reference');
});

test('a literal secret written into the file is refused', () => {
  const raw = valid();
  raw.upstreams.payments.env = { API_KEY: 'sk_live_51HxAbCdEfGhIjKl', REGION: '${REGION}' };
  has(problemsOf(raw), 'upstreams.payments.env.API_KEY: looks like a secret');
});

test('decision 4: every upstream offers something, and an unreviewed draft does not start', () => {
  const raw = valid();
  raw.tools['crm.lookup_customer'] = { ...raw.tools['crm.lookup_customer'], review: true };
  const p = problemsOf(raw);
  has(p, 'still marked "review": true');
  has(p, 'upstreams.crm: no tool of it is mapped');
});

test('T4: a tool must be pinned to the definition that was reviewed', () => {
  const raw = valid();
  delete raw.tools['crm.lookup_customer'].schemaHash;
  has(problemsOf(raw), 'crm.lookup_customer.schemaHash');
});

test('value fields must name allowed arguments, and an amount needs its currency', () => {
  const raw = valid();
  raw.tools['payments.create_payment'].merchant = 'recipient';
  delete raw.tools['payments.create_payment'].currency;
  const p = problemsOf(raw);
  has(p, 'merchant: "recipient" is not in allowedArgs');
  has(p, 'must also map its currency');
});

test('names: bad upstream names, unknown upstreams, over-long exposed names and collisions are refused', () => {
  const raw = valid();
  raw.upstreams.Bad_Name = raw.upstreams.crm;
  raw.tools['ghost.tool'] = { action: 'x', allowedArgs: [], schemaHash: HASH };
  raw.tools[`crm.${'t'.repeat(70)}`] = { action: 'x', allowedArgs: [], schemaHash: HASH };
  const p = problemsOf(raw);
  has(p, 'upstreams.Bad_Name: a name is lower-case');
  has(p, 'no upstream named "ghost"');
  has(p, 'must be at most 64 characters');
});

test('remote upstreams must use https, except to this machine', () => {
  const raw = valid();
  raw.upstreams.crm.url = 'http://crm.example.com/mcp';
  has(problemsOf(raw), 'upstreams.crm.url: must be https');
  raw.upstreams.crm.url = 'http://localhost:8080/mcp';
  assert.deepEqual(problemsOf(raw), []);
});

test('an upstream is either local (command) or remote (url), never both', () => {
  const raw = valid();
  raw.upstreams.payments.url = 'https://x.example.com';
  has(problemsOf(raw), 'give either "command"');
});

test('every problem is reported at once', () => {
  const p = problemsOf({ upstreams: {}, tools: {} });
  has(p, 'agentConfig');
  has(p, '"upstreams" must list');
  has(p, '"tools" must map');
});
