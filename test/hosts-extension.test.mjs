import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOSTS, PACKAGE, directAccessWarning, hostSnippet } from '../src/hosts.mjs';
import { AGENT_KEY_ENV, buildExtension, planExtension } from '../src/extension.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const input = { configPath: '/home/sam/metamynd/mcp-gateway.json', version: '1.2.3' };

test('every host snippet pins the scoped package and carries no credential', () => {
  for (const host of Object.keys(HOSTS)) {
    const { snippet } = hostSnippet(host, input);
    assert.ok(snippet.includes(`${PACKAGE}@1.2.3`), `${host} pins the version`);
    assert.ok(snippet.includes(input.configPath), `${host} names the config`);
    assert.doesNotMatch(snippet, /api[_-]?key|token|secret|password/i, `${host} holds no secret`);
  }
});

test('host snippets follow each app\'s own format (docs/hosts.md)', () => {
  assert.ok(JSON.parse(hostSnippet('claude-desktop', input).snippet).mcpServers.metamynd);
  assert.ok(JSON.parse(hostSnippet('vscode', input).snippet).servers.metamynd, 'VS Code uses "servers"');
  assert.equal(JSON.parse(hostSnippet('cursor', input).snippet).mcpServers.metamynd.type, 'stdio');
  assert.match(hostSnippet('claude-code', input).snippet, /^claude mcp add --transport stdio metamynd -- npx /);
  assert.match(hostSnippet('openai-agents-python', input).snippet, /client_session_timeout_seconds=30/);
  assert.throws(() => hostSnippet('notepad', input), /unknown host/);
});

const raw = {
  agentConfig: './agent.metamynd.json',
  upstreams: {
    payments: { command: 'npx', args: ['-y', 'payments-mcp@1.0.0'], env: { API_KEY: 'keychain:payments-api-key', REGION: 'eu' } },
    crm: { url: 'https://crm.example.com/mcp', headers: { Authorization: 'Bearer ${CRM_TOKEN}' } },
  },
  tools: {},
};

test('the extension plan: every credential becomes a sensitive field; the bundle carries no secret', () => {
  const agentFile = { apiBase: 'https://metamynd.ai/api/v1', agentDid: 'did:hedera:testnet:zAbc_0.0.1', agentKey: '302e020100300506032b6570deadbeefkeymaterial' };
  const plan = planExtension({ raw, agentFile, version: '1.2.3', agentName: 'Accounts Payable' });
  const uc = /** @type {Record<string, any>} */ (plan.manifest.user_config);
  assert.deepEqual(Object.keys(uc).sort(), ['crm_token', 'mcpgw_agent_key', 'mcpgw_secret_payments_api_key']);
  assert.ok(Object.values(uc).every((f) => f.sensitive === true && f.required === true));
  const env = plan.manifest.server.mcp_config.env;
  assert.equal(env[AGENT_KEY_ENV], '${user_config.mcpgw_agent_key}');
  assert.equal(env.CRM_TOKEN, '${user_config.crm_token}');
  assert.equal(plan.gatewayConfig.upstreams.payments.env.API_KEY, '${MCPGW_SECRET_PAYMENTS_API_KEY}', 'keychain refs become the field Claude stores');
  assert.equal(plan.gatewayConfig.upstreams.payments.env.REGION, 'eu');
  assert.equal(plan.agentFile.agentKey, undefined, 'the agent key is not in the bundle');
  assert.ok(!JSON.stringify([plan.manifest, plan.gatewayConfig, plan.agentFile]).includes('deadbeefkeymaterial'));
  assert.equal(plan.manifest.name, 'metamynd-accounts-payable');
  assert.equal(plan.manifest.manifest_version, '0.2');
});

test('an agent that signs through the signer daemon needs no agent key field', () => {
  const plan = planExtension({ raw, agentFile: { agentDid: 'did:x', keyProvider: 'daemon' }, version: '1.0.0' });
  assert.equal(/** @type {any} */ (plan.manifest.user_config).mcpgw_agent_key, undefined);
});

test('a machine-specific command path is flagged', () => {
  const r = { ...raw, upstreams: { local: { command: process.execPath, env: { K: '${K}' } } } };
  assert.match(planExtension({ raw: r, agentFile: {}, version: '1.0.0' }).warnings.join(), /path on this machine/);
});

test('the built .mcpb passes the official mcpb validator and packs', { skip: !process.env.MCPGW_TEST_PACK && 'set MCPGW_TEST_PACK=1 (fetches dependencies)' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcpgw-ext-'));
  const plan = planExtension({ raw, agentFile: { agentDid: 'did:hedera:testnet:zAbc_0.0.1', apiBase: 'https://metamynd.ai/api/v1' }, version: '0.0.0', agentName: 'Test' });
  const out = path.join(dir, 'test.mcpb');
  await buildExtension(plan, { outFile: out, packageRoot: path.join(here, '..') });
  assert.ok(existsSync(out));
});

test('T1: every setup says to remove a direct connection to the same server, naming it', () => {
  const w = directAccessWarning('Cursor', ['Notion']);
  assert.match(w, /^If Notion is also set up in Cursor directly/);
  assert.match(w, /remove it entirely: disconnecting is not enough/);
  assert.match(w, /without MetaMynd/);
  assert.match(directAccessWarning('VS Code', []), /^If these tools are also set up in VS Code directly .*remove them entirely: .*still offer them to the AI\./);
});