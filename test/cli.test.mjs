// The real thing, as a host runs it: the CLI started as a child process over stdio, launching a real upstream server
// process with the credential from the environment. MetaMynd is pointed at an address that does not answer, so this
// proves the gateway starts and offers the tool, and then FAILS CLOSED: nothing reaches the upstream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { schemaHashOf } from '../src/schema-hash.mjs';
import { testAgent } from './fake-gate.mjs';
import { PAY_TOOL } from './fixtures/upstream.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('the CLI over stdio: offers the reviewed tool, refuses when MetaMynd cannot be reached, never runs the upstream', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcpgw-cli-'));
  const ranFile = path.join(dir, 'ran.log');
  const { agentDid, agentKey } = await testAgent();
  await writeFile(path.join(dir, 'agent.metamynd.json'), JSON.stringify({ apiBase: 'http://127.0.0.1:9/api/v1', agentDid, agentKey }));
  await writeFile(path.join(dir, 'mcp-gateway.json'), JSON.stringify({
    agentConfig: './agent.metamynd.json',
    upstreams: { payments: { command: process.execPath, args: [path.join(here, 'fixtures', 'upstream.mjs'), 'serve'], env: { API_KEY: '${PAY_KEY}', RAN_FILE: '${RAN_FILE}' } } },
    tools: { 'payments.create_payment': { action: 'payment.create', amount: 'amount', currency: 'currency', merchant: 'payee', allowedArgs: ['amount', 'currency', 'payee'], schemaHash: schemaHashOf(PAY_TOOL) } },
  }));

  const app = new Client({ name: 'ai-app', version: '0' });
  await app.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, '..', 'src', 'cli.mjs'), '--config', path.join(dir, 'mcp-gateway.json'), '--state-dir', path.join(dir, 'state')],
    env: { PAY_KEY: 'test-key', RAN_FILE: ranFile, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    stderr: 'ignore',
  }));
  try {
    const { tools } = await app.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['payments__create_payment']);
    const r = await app.callTool({ name: 'payments__create_payment', arguments: { amount: 5, currency: 'USD', payee: 'acme' } });
    assert.equal(r.isError, true);
    assert.match(JSON.stringify(r.content), /GATE_UNREACHABLE/);
    assert.equal(existsSync(ranFile), false, 'the upstream never ran the call');
  } finally {
    await app.close();
  }
});
