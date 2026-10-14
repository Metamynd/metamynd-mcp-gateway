import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { configFromCatalog, loadCatalog } from '../src/catalog.mjs';
import { baseManifest, buildBase, composeExtension, planExtension } from '../src/extension.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeBase = (version = '0.2.0') => zipSync({
  'manifest.json': strToU8(JSON.stringify(baseManifest(version))),
  'server/package.json': strToU8(JSON.stringify({ name: '@metamynd/mcp-gateway', version })),
  'server/src/cli.mjs': strToU8('// cli'),
  'server/catalog/notion.json': strToU8('{}'),
  'mcp-gateway.json': strToU8('{"stale":true}'),
});

async function notionPlan(version = '0.2.0', agentFile = /** @type {Record<string, any>} */ ({ agentDid: 'did:hedera:testnet:zAbc_0.0.1', apiBase: 'https://metamynd.ai/api/v1' })) {
  const catalog = await loadCatalog();
  const raw = configFromCatalog(catalog.values(), { agentConfig: './agent.metamynd.json', picks: [{ id: 'notion', tools: ['API-post-search', 'API-post-page'] }] });
  return planExtension({ raw, agentFile, version, agentName: 'Docs helper' });
}

test('compose: the base\'s server with this agent\'s manifest, config and agent file — and nothing else', async () => {
  const files = unzipSync(composeExtension(fakeBase(), await notionPlan()));
  assert.deepEqual(Object.keys(files).sort(), ['agent.metamynd.json', 'manifest.json', 'mcp-gateway.json', 'server/catalog/notion.json', 'server/package.json', 'server/src/cli.mjs']);
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  assert.equal(manifest.name, 'metamynd-docs-helper');
  assert.deepEqual(Object.keys(manifest.user_config), ['mcpgw_agent_key', 'notion_token']);
  const config = JSON.parse(strFromU8(files['mcp-gateway.json']));
  assert.deepEqual(Object.keys(config.tools), ['notion.API-post-search', 'notion.API-post-page'], 'the stale base config was replaced');
});

test('compose refuses: a key in the agent file, a version mismatch, something that is not a base', async () => {
  const plan = await notionPlan();
  assert.throws(() => composeExtension(fakeBase(), { ...plan, agentFile: { ...plan.agentFile, agentKey: '302e…' } }), /refusing to put an agent key/);
  assert.throws(() => composeExtension(fakeBase('0.1.0'), plan), /base is gateway 0\.1\.0, the plan is for 0\.2\.0/);
  assert.throws(() => composeExtension(zipSync({ 'readme.txt': strToU8('hi') }), plan), /not a MetaMynd gateway base bundle/);
});

test('a real base, composed for an agent, runs as Claude Desktop runs it', { skip: !process.env.MCPGW_TEST_PACK && 'set MCPGW_TEST_PACK=1 (builds a real base; fetches dependencies)' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcpgw-base-'));
  const baseFile = path.join(dir, 'base.mcpb');
  await buildBase({ outFile: baseFile, packageRoot: path.join(here, '..') });
  const { version } = JSON.parse(await readFile(path.join(here, '..', 'package.json'), 'utf8'));
  const plan = await notionPlan(version);
  const files = unzipSync(composeExtension(new Uint8Array(await readFile(baseFile)), plan));
  assert.ok(files['server/node_modules/@metamynd/agentsafe-guard/package.json'], 'the base carries the gateway\'s dependencies');
  // Unpack it and start it the way Claude Desktop does: the manifest's command, the fields as environment variables.
  const unpacked = path.join(dir, 'unpacked');
  const { mkdir, writeFile } = await import('node:fs/promises');
  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith('/')) continue;
    await mkdir(path.dirname(path.join(unpacked, name)), { recursive: true });
    await writeFile(path.join(unpacked, name), bytes);
  }
  const manifest = JSON.parse(strFromU8(files['manifest.json']));
  const args = manifest.server.mcp_config.args.map((/** @type {string} */ a) => a.replaceAll('${__dirname}', unpacked));
  assert.ok(existsSync(args[0]));
  // NOTION_TOKEN is a dummy: listing the gateway's tools starts the real Notion server, which needs none to list.
  const app = new Client({ name: 'claude-desktop-sim', version: '0' });
  await app.connect(new StdioClientTransport({ command: process.execPath, args, env: { MCPGW_AGENT_KEY: '302e020100300506032b657004220420' + '11'.repeat(32), NOTION_TOKEN: 'ntn_dummy', PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, stderr: 'ignore' }));
  try {
    const { tools } = await app.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['notion__API-post-page', 'notion__API-post-search']);
  } finally {
    await app.close();
  }
});
