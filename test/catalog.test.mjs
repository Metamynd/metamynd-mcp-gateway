import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, parseConfig } from '../src/config.mjs';
import { catalogPicksIn, configFromCatalog, credentialFields, entryProblems, loadCatalog, serviceSetupFor } from '../src/catalog.mjs';
import { planExtension } from '../src/extension.mjs';

test('the shipped catalog loads, and every entry passes the gateway\'s own checks', async () => {
  const catalog = await loadCatalog();
  assert.ok(catalog.has('notion'));
  const notion = /** @type {any} */ (catalog.get('notion'));
  assert.match(notion.server.version, /^\d+\.\d+\.\d+$/, 'pinned to an exact version');
  assert.equal(Object.keys(notion.tools).length, 24);
  for (const [name, t] of Object.entries(notion.tools)) {
    assert.ok(/** @type {any} */ (t).summary.length > 5, `${name} has a plain-language summary`);
  }
  assert.equal(notion.tools['API-post-search'].effect, 'read', 'reviewed: a search is a read, whatever the server claims');
  assert.equal(notion.tools['API-delete-a-block'].action, 'notion-delete');
});

test('configFromCatalog: only the picked tools, credentials as references, actions renamed to the mandate\'s', async () => {
  const catalog = await loadCatalog();
  const config = configFromCatalog(catalog.values(), {
    agentConfig: './agent.metamynd.json',
    picks: [{ id: 'notion', tools: ['API-post-search', 'API-post-page'] }],
    actionMap: { 'notion-write': 'docs-edit' },
  });
  assert.deepEqual(Object.keys(config.tools), ['notion.API-post-search', 'notion.API-post-page']);
  assert.equal(config.tools['notion.API-post-page'].action, 'docs-edit');
  assert.equal(config.tools['notion.API-post-search'].action, 'notion-read');
  assert.equal(config.tools['notion.API-post-page'].summary, undefined, 'summaries are for people, not the config');
  assert.deepEqual(config.upstreams.notion.args, ['-y', '@notionhq/notion-mcp-server@2.5.2']);
  assert.deepEqual(config.upstreams.notion.env, { NOTION_TOKEN: '${NOTION_TOKEN}' });
  assert.equal(parseConfig(config, '/x').tools.size, 2, 'a valid gateway config');

  const kc = configFromCatalog(catalog.values(), { agentConfig: './a.json', picks: [{ id: 'notion', tools: ['API-get-self'] }], credentials: 'keychain' });
  assert.equal(kc.upstreams.notion.env.NOTION_TOKEN, 'keychain:notion-notion-token');
});

test('configFromCatalog refuses unknown entries and tools', async () => {
  const catalog = await loadCatalog();
  assert.throws(() => configFromCatalog(catalog.values(), { agentConfig: './a.json', picks: [{ id: 'nope', tools: [] }] }), (e) => e instanceof ConfigError && /no catalog entry "nope"/.test(e.message));
  assert.throws(() => configFromCatalog(catalog.values(), { agentConfig: './a.json', picks: [{ id: 'notion', tools: ['API-format-disk'] }] }), /no tool "API-format-disk"/);
});

test('the catalog flows into a Claude Desktop extension with the credential as a secure field', async () => {
  const catalog = await loadCatalog();
  const raw = configFromCatalog(catalog.values(), { agentConfig: './agent.metamynd.json', picks: [{ id: 'notion', tools: ['API-post-search'] }] });
  const plan = planExtension({ raw, agentFile: { agentDid: 'did:x', keyProvider: 'daemon' }, version: '0.2.0', agentName: 'Docs helper' });
  assert.deepEqual(Object.keys(/** @type {any} */ (plan.manifest.user_config)), ['notion_token']);
  assert.equal(plan.manifest.server.mcp_config.env.NOTION_TOKEN, '${user_config.notion_token}');
  assert.equal(/** @type {any} */ (plan.manifest.user_config).notion_token.title, 'notion: NOTION_TOKEN'); // no fields: generic
});

test('the extension asks for each credential by its catalog title, in both credential forms', async () => {
  const catalog = await loadCatalog();
  const picks = [{ id: 'notion', tools: ['API-post-search'] }];
  const notion = /** @type {any} */ (catalog.get('notion')).credentials[0];
  const fields = credentialFields(catalog.values(), picks);
  const agentFile = { agentDid: 'did:x', keyProvider: 'daemon' };

  const envRaw = configFromCatalog(catalog.values(), { agentConfig: './a.json', picks });
  const byEnv = /** @type {any} */ (planExtension({ raw: envRaw, agentFile, version: '0.2.1', fields }).manifest.user_config);
  assert.deepEqual(byEnv.notion_token, { type: 'string', title: 'Notion integration token', description: notion.description, sensitive: true, required: true });

  const kcRaw = configFromCatalog(catalog.values(), { agentConfig: './a.json', picks, credentials: 'keychain' });
  const byKc = /** @type {any} */ (planExtension({ raw: kcRaw, agentFile, version: '0.2.1', fields }).manifest.user_config);
  assert.equal(byKc.mcpgw_secret_notion_notion_token.title, 'Notion integration token');
});

test('catalogPicksIn finds catalog servers in a config, not hand-written look-alikes', async () => {
  const catalog = [...(await loadCatalog()).values()];
  const raw = configFromCatalog(catalog, { agentConfig: './a.json', picks: [{ id: 'notion', tools: ['API-post-search'] }] });
  assert.deepEqual(catalogPicksIn(catalog, raw), [{ id: 'notion' }]);
  assert.deepEqual(catalogPicksIn(catalog, { upstreams: { notion: { command: 'node', args: ['./my-notion.mjs'] } } }), []);
  assert.deepEqual(catalogPicksIn(catalog, {}), []);
});

test('entryProblems catches what a reviewer could miss', () => {
  const good = {
    id: 'demo', name: 'Demo', description: 'd', server: { package: 'demo-mcp', version: '1.2.3' },
    credentials: [{ env: 'DEMO_KEY', title: 'Key', description: 'd' }], probeEnv: { DEMO_KEY: 'x' },
    actions: { 'demo-pay': 'Pay' }, reviewed: { by: 'MetaMynd', on: '2026-10-14' },
    tools: { pay: { summary: 'Pay someone', action: 'demo-pay', effect: 'write', amount: 'amount', currency: 'currency', allowedArgs: ['amount', 'currency'], context: { riskLevel: 'high' }, schemaHash: `sha256:${'b'.repeat(64)}` } },
  };
  assert.deepEqual(entryProblems(good), []);
  assert.match(entryProblems({ ...good, server: { package: 'demo-mcp', version: 'latest' } }).join(), /exact version/);
  assert.match(entryProblems({ ...good, credentials: [] }).join(), /at least one credential/);
  assert.match(entryProblems({ ...good, probeEnv: {} }).join(), /probeEnv must give a dummy DEMO_KEY/);
  assert.match(entryProblems({ ...good, tools: { pay: { ...good.tools.pay, action: 'ghost' } } }).join(), /not described in "actions"/);
  assert.match(entryProblems({ ...good, tools: { pay: { ...good.tools.pay, effect: 'read' } } }).join(), /moves an amount is not "read"/);
});

test('serviceSetupFor: only the service permissions the picked tools need, each once, in catalog order', async () => {
  const catalog = await loadCatalog();
  const readOnly = serviceSetupFor(catalog.values(), [{ id: 'notion', tools: ['API-post-search', 'API-retrieve-a-comment'] }]);
  assert.deepEqual(readOnly.map((s) => s.capabilities), [['Read content', 'Read comments', 'Read user information without email addresses']]);
  assert.equal(readOnly[0].server, 'Notion');
  assert.match(readOnly[0].scope, /Share only the pages/);
  const readWrite = serviceSetupFor(catalog.values(), [{ id: 'notion', tools: ['API-patch-block-children', 'API-post-search', 'API-delete-a-block'] }]);
  assert.deepEqual(readWrite[0].capabilities, ['Read content', 'Read comments', 'Read user information without email addresses', 'Insert content', 'Update content', 'Insert comments']);
  assert.deepEqual(serviceSetupFor(catalog.values(), [{ id: 'nope', tools: ['x'] }]), []);
});

test('entryProblems: a serviceSetup must cover every action, and only the entry\'s actions', async () => {
  const notion = /** @type {any} */ ((await loadCatalog()).get('notion'));
  assert.deepEqual(entryProblems(notion), []);
  const missing = { ...notion, serviceSetup: { ...notion.serviceSetup, byAction: { 'notion-read': ['Read content'] } } };
  assert.match(entryProblems(missing).join(), /"notion-write" needs the service permissions/);
  const extra = { ...notion, serviceSetup: { ...notion.serviceSetup, byAction: { ...notion.serviceSetup.byAction, 'notion-pay': ['x'] } } };
  assert.match(entryProblems(extra).join(), /"notion-pay" is not one of the entry's actions/);
  assert.match(entryProblems({ ...notion, serviceSetup: { ...notion.serviceSetup, scope: '' } }).join(), /"scope" is required/);
  const { serviceSetup: _s, ...without } = notion;
  assert.deepEqual(entryProblems(without), []); // optional: an entry may leave it out
});
test('configFromCatalog for a folder-started app: per-agent keychain names, and the agent key as a reference', async () => {
  const catalog = await loadCatalog();
  const raw = configFromCatalog(catalog.values(), {
    agentConfig: './agent.metamynd.json', picks: [{ id: 'notion', tools: ['API-post-search'] }],
    credentials: 'keychain', keychainPrefix: 'metamynd-docs-helper-', agentKey: 'keychain:metamynd-docs-helper-agent-key',
  });
  assert.deepEqual(raw.upstreams.notion.env, { NOTION_TOKEN: 'keychain:metamynd-docs-helper-notion-notion-token' });
  assert.equal(raw.agentKey, 'keychain:metamynd-docs-helper-agent-key');
  assert.equal(parseConfig(raw, '/').agentKey, 'keychain:metamynd-docs-helper-agent-key');
});