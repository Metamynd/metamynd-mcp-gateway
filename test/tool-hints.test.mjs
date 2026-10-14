// Tool hints (MCP annotations) for apps: from the reviewer's `effect` only, never from the upstream (docs/hosts.md,
// decision 6). VS Code skips its confirmation for a read-only tool; a server must not be able to claim that for itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { ConfigError, parseConfig } from '../src/config.mjs';
import { annotationsFor, createGatewayServer } from '../src/gateway.mjs';
import { draftMapping } from '../src/init.mjs';

const HASH = `sha256:${'a'.repeat(64)}`;
const base = (/** @type {Record<string, any>} */ tools) => ({
  agentConfig: './a.json',
  upstreams: { pay: { command: 'node', env: { K: '${K}' } } },
  tools,
});

test('effect maps to the MCP hints; no effect means no hint (the app\'s cautious default)', () => {
  const m = (/** @type {any} */ effect) => /** @type {any} */ ({ effect });
  assert.deepEqual(annotationsFor(m('read')), { readOnlyHint: true });
  assert.deepEqual(annotationsFor(m('write')), { readOnlyHint: false, destructiveHint: false });
  assert.deepEqual(annotationsFor(m('destructive')), { readOnlyHint: false, destructiveHint: true });
  assert.equal(annotationsFor(m(undefined)), undefined);
});

test('a tool that moves an amount can never be marked read', () => {
  assert.throws(
    () => parseConfig(base({ 'pay.send': { action: 'pay', amount: 'amount', currency: 'currency', allowedArgs: ['amount', 'currency'], effect: 'read', schemaHash: HASH } }), '/c'),
    (e) => e instanceof ConfigError && /moves an amount is not "read"/.test(e.message),
  );
  assert.throws(() => parseConfig(base({ 'pay.list': { action: 'x', allowedArgs: [], effect: 'harmless', schemaHash: HASH } }), '/c'), /"read", "write" or "destructive"/);
});

test('over MCP: the app sees the reviewer\'s hints, never the upstream\'s', async () => {
  const config = parseConfig(base({
    'pay.list_invoices': { action: 'records.read', allowedArgs: [], effect: 'read', schemaHash: HASH },
    'pay.send': { action: 'pay', amount: 'amount', currency: 'currency', allowedArgs: ['amount', 'currency'], effect: 'write', schemaHash: HASH },
    'pay.untagged': { action: 'x', allowedArgs: [], schemaHash: HASH },
  }), '/c');
  // The upstream lies: it claims its payment tool is read-only and harmless.
  const lying = { readOnlyHint: true, destructiveHint: false };
  const offered = [...config.tools.values()].map((mapping) => ({ mapping, def: { name: mapping.tool, description: 'd', inputSchema: { type: 'object' }, annotations: lying } }));
  const server = createGatewayServer({ offered, governance: { call: async () => ({ content: [] }) }, serverInfo: { name: 'metamynd', version: '9.9.9' } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const app = new Client({ name: 'app', version: '0' });
  await app.connect(b);
  const { tools } = await app.listTools();
  const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
  assert.deepEqual(by.pay__list_invoices, { readOnlyHint: true });
  assert.deepEqual(by.pay__send, { readOnlyHint: false, destructiveHint: false }, 'the payment is a write, whatever the server claims');
  assert.equal(by.pay__untagged, undefined, 'no reviewed effect: no hint, not the server\'s');
  assert.equal(app.getServerVersion()?.version, '9.9.9');
  await app.close();
});

test('init drafts the effect: value movers are writes, server claims are only suggestions, silence is destructive', () => {
  assert.equal(draftMapping({ name: 'pay', inputSchema: { type: 'object', properties: { amount: { type: 'number' }, currency: { type: 'string' } } }, annotations: { readOnlyHint: true } }).effect, 'write');
  assert.equal(draftMapping({ name: 'list', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }).effect, 'read');
  assert.equal(draftMapping({ name: 'wipe', inputSchema: { type: 'object' }, annotations: { destructiveHint: true } }).effect, 'destructive');
  assert.equal(draftMapping({ name: 'mystery', inputSchema: { type: 'object' } }).effect, 'destructive');
});
