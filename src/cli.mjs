#!/usr/bin/env node
// mcp-gateway — the MetaMynd MCP gateway.
//
//   mcp-gateway [serve] --config <mcp-gateway.json> [--state-dir <dir>]   run it for an AI app, over stdio
//   mcp-gateway serve --http --config <file> [--host 127.0.0.1] [--port 8787]
//               [--tls-cert <pem> --tls-key <pem> | --behind-tls-proxy] [--allowed-origin <o>]...
//                                                                        run it remotely, over Streamable HTTP (on your own server)
//   mcp-gateway token create [--label <text>] | token list | token revoke <id>   access tokens for --http
//   mcp-gateway init --config <mcp-gateway.json>                         draft the mapping for every upstream tool
//   mcp-gateway secret set <name>                                        store a credential in the OS keychain
//   mcp-gateway secret check <name>                                      say whether it is there (never prints it)
//   mcp-gateway config --host <app> --config <file>                      print the snippet that adds it to an AI app
//   mcp-gateway extension --config <file> [--name <agent>] [--out x.mcpb] build a one-click Claude Desktop extension
//
// MCP_GATEWAY_CONFIG may stand in for --config. When serving, stdout carries the MCP protocol, so everything the
// gateway reports goes to stderr, which AI apps log.

import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createGuardFromConfig } from '@metamynd/agentsafe-guard';
import { ConfigError, loadConfig, parseDraftConfig } from './config.mjs';
import { createGatewayServer } from './gateway.mjs';
import { GUARD_OPTIONS, createGovernance } from './governance.mjs';
import { catalogPicksIn, credentialFields, loadCatalog, serviceSetupFor } from './catalog.mjs';
import { AGENT_KEY_ENV, buildExtension, composeExtension, planExtension } from './extension.mjs';
import { HOSTS, directAccessWarning, hostSnippet } from './hosts.mjs';
import { draftTools } from './init.mjs';
import { openJournal } from './journal.mjs';
import { createHttpListener, listen, listenProblem, MCP_PATH } from './http.mjs';
import { createKeychain } from './keychain.mjs';
import { createToken, listTokens, revokeToken, tokenFile, tokenVerifier } from './tokens.mjs';
import { resolveSecrets, SecretError } from './secrets.mjs';
import { connectUpstreams, listAllTools, reconcileTools } from './upstreams.mjs';

/** @param {Record<string, unknown>} entry */
const log = (entry) => process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), source: 'metamynd-mcp-gateway', ...entry })}\n`);
/** @param {string} line */
const say = (line) => process.stderr.write(`${line}\n`);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' }, 'state-dir': { type: 'string' }, host: { type: 'string' }, out: { type: 'string' }, name: { type: 'string' }, base: { type: 'string' },
    http: { type: 'boolean' }, port: { type: 'string' }, 'tls-cert': { type: 'string' }, 'tls-key': { type: 'string' },
    'behind-tls-proxy': { type: 'boolean' }, 'allowed-origin': { type: 'string', multiple: true }, label: { type: 'string' },
  },
});
const stateDir = values['state-dir'] ?? path.join(os.homedir(), '.metamynd', 'mcp-gateway');
const keychain = createKeychain({ stateDir });
const sources = { env: process.env, keychain: keychain.get };

function configFile() {
  const file = values.config ?? process.env.MCP_GATEWAY_CONFIG;
  if (!file) throw new ConfigError(['no config: pass --config <mcp-gateway.json> or set MCP_GATEWAY_CONFIG']);
  return file;
}

async function serve() {
  // --http: check how it will listen, and that someone can sign in, before starting anything (fail fast and closed).
  /** @type {{ host: string, port: number, tls?: { cert: Buffer, key: Buffer } } | null} */
  let httpListen = null;
  if (values.http) {
    const host = values.host ?? '127.0.0.1';
    const port = Number(values.port ?? 8787);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError([`--port must be a port number, not "${values.port}"`]);
    if (Boolean(values['tls-cert']) !== Boolean(values['tls-key'])) throw new ConfigError(['--tls-cert and --tls-key go together']);
    const tls = values['tls-cert'] && values['tls-key'] ? { cert: await readFile(values['tls-cert']), key: await readFile(values['tls-key']) } : undefined;
    const problem = listenProblem({ host, tls, behindTlsProxy: values['behind-tls-proxy'] });
    if (problem) throw new ConfigError([problem]);
    if ((await tokenVerifier(tokenFile(stateDir)).count()) === 0) {
      throw new ConfigError([`no access token: create one with \`mcp-gateway token create --label <app> --state-dir ${stateDir}\` and give it to the AI app`]);
    }
    httpListen = { host, port, tls };
  } else if (values.host || values.port || values['tls-cert'] || values['behind-tls-proxy'] || values['allowed-origin']) {
    throw new ConfigError(['--host, --port, --tls-cert, --tls-key, --behind-tls-proxy and --allowed-origin need --http']);
  }

  const config = await loadConfig(configFile());
  for (const w of config.warnings) log({ event: 'warning', message: w });

  // T3: the agent's key must not sit where the AI app could read it. A plaintext key works, but is flagged every start.
  const agentFile = JSON.parse(await readFile(config.agentConfig, 'utf8'));
  if (typeof agentFile.agentKey === 'string' && agentFile.agentKey) {
    log({ event: 'warning', message: `${config.agentConfig} holds the agent's key in plain text; keep it in the signer daemon (keyProvider: "daemon") so no tool the AI can use can read it` });
  }
  // Where the key comes from: a Claude Desktop extension passes the one it stored securely in MCPGW_AGENT_KEY
  // (src/extension.mjs); a gateway started from a folder names it in "agentKey" (keychain or environment); otherwise the
  // agent file decides (signer daemon, or a plaintext key flagged above).
  let agentKey = process.env[AGENT_KEY_ENV] || undefined;
  if (!agentKey && config.agentKey) {
    /** @type {string[]} */
    const missing = [];
    agentKey = (await resolveSecrets({ agentKey: config.agentKey }, 'mcp-gateway.json', sources, missing)).agentKey;
    if (missing.length) throw new SecretError(missing);
  }
  const guard = await createGuardFromConfig(config.agentConfig, { ...GUARD_OPTIONS, ...(agentKey ? { agentKey } : {}) });

  const clients = await connectUpstreams(config, { sources });
  /** @type {Map<string, import('./upstreams.mjs').ToolDef[]>} */
  const toolsByUpstream = new Map();
  for (const [name, client] of clients) toolsByUpstream.set(name, await listAllTools(client));
  const { offered, withheld } = reconcileTools(config, toolsByUpstream);
  for (const w of withheld) log({ event: 'withheld', tool: w.tool, reason: w.reason });

  const agentTag = createHash('sha256').update(guard.agentDid).digest('hex').slice(0, 16);
  const journal = await openJournal(path.join(stateDir, `held-${agentTag}.json`));
  const governance = createGovernance({
    guard,
    journal,
    escalationWaitMs: config.escalationWaitMs,
    log,
    callUpstream: (mapping, args) => /** @type {any} */ (clients.get(mapping.upstream)).callTool({ name: mapping.tool, arguments: args }),
  });
  const serverInfo = { name: 'metamynd', version: await ownVersion() };
  const ready = { event: 'ready', agentDid: guard.agentDid, offered: offered.length, withheld: withheld.length, upstreams: clients.size };

  /** @type {Array<() => Promise<unknown>>} */
  const closers = [];
  const shutdown = async () => {
    await Promise.allSettled(closers.map((c) => c()));
    await Promise.allSettled([...clients.values()].map((c) => c.close()));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (httpListen) {
    // Last resort: a long-running server must say why it stopped, in the log the operator reads.
    process.on('uncaughtException', (err) => { log({ event: 'fatal', message: err.stack ?? err.message }); process.exit(1); });
    // One fresh MCP server per HTTP request, all over the same governance, journal and upstream connections.
    const listener = createHttpListener({
      makeServer: () => createGatewayServer({ offered, governance, serverInfo }),
      verifier: tokenVerifier(tokenFile(stateDir)),
      allowedOrigins: values['allowed-origin'] ?? [],
      log,
    });
    const httpServer = /** @type {import('node:http').Server} */ (await listen(listener, httpListen));
    closers.push(() => listener.close(), () => new Promise((r) => httpServer.close(r)));
    const address = /** @type {import('node:net').AddressInfo} */ (httpServer.address());
    log({ ...ready, transport: 'http', url: `${httpListen.tls ? 'https' : 'http'}://${httpListen.host}:${address.port}${MCP_PATH}`, behindTlsProxy: Boolean(values['behind-tls-proxy']) });
    return;
  }

  const server = createGatewayServer({ offered, governance, serverInfo });
  await server.connect(new StdioServerTransport());
  log({ ...ready, transport: 'stdio' });
  process.stdin.on('close', shutdown);
}

async function token() {
  const [, verb, id] = positionals;
  const file = tokenFile(stateDir);
  if (verb === 'create') {
    const { token: value, entry } = await createToken(file, values.label);
    say(`Created token ${entry.id}${entry.label ? ` (${entry.label})` : ''}. It is shown once, below; only its hash is kept.`);
    say('Give it to the AI app as the header  Authorization: Bearer <token>  and keep it out of chats, prompts and files the AI can read.');
    process.stdout.write(`${value}\n`);
    return;
  }
  if (verb === 'list') {
    const tokens = await listTokens(file);
    if (!tokens.length) say('No tokens.');
    for (const t of tokens) say(`${t.id}  ${t.revokedAt ? `revoked ${t.revokedAt}` : 'active'}  created ${t.createdAt}${t.label ? `  ${t.label}` : ''}`);
    return;
  }
  if (verb === 'revoke' && id) {
    if (!(await revokeToken(file, id))) throw new ConfigError([`no token "${id}"; see \`mcp-gateway token list\``]);
    say(`Revoked ${id}. A running gateway refuses it from the next request.`);
    return;
  }
  throw new ConfigError(['usage: mcp-gateway token create [--label <text>] | token list | token revoke <id>']);
}

async function init() {
  const file = configFile();
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const head = parseDraftConfig(raw, path.dirname(path.resolve(file)));
  const clients = await connectUpstreams(/** @type {any} */ ({ ...head, tools: new Map() }), { sources });
  try {
    /** @type {Map<string, import('./upstreams.mjs').ToolDef[]>} */
    const toolsByUpstream = new Map();
    for (const [name, client] of clients) toolsByUpstream.set(name, await listAllTools(client));
    const { config, drafted, changed, missing, tooLong } = draftTools(raw, toolsByUpstream);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`);
    await rename(tmp, file);
    say(`Drafted ${drafted.length} tool(s) in ${file}${drafted.length ? ':' : '.'}`);
    for (const t of drafted) say(`  + ${t}  (marked "review": true)`);
    for (const c of changed) say(`  ! ${c.tool}: its definition changed since review — check it, then set "schemaHash": "${c.schemaHash}"`);
    for (const m of missing) say(`  - ${m}: the server no longer offers it; remove the entry`);
    for (const t of tooLong) say(`  ! ${t}: the name the app sees is too long; give the upstream a shorter name`);
    if (drafted.length) say('Review each drafted tool — its action must match the agent\'s mandate — then remove its "review" flag. The gateway will not start until you do.');
  } finally {
    await Promise.allSettled([...clients.values()].map((c) => c.close()));
  }
}

/** Read a secret from the terminal without echoing it, or from piped stdin. */
async function readSecret(/** @type {string} */ prompt) {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks = [];
    for await (const c of stdin) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    /** @param {Buffer} buf */
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { done(); resolve(value); return; }
        if (ch === '\u0003') { done(); reject(new Error('cancelled')); return; }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    const done = () => { stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); process.stderr.write('\n'); };
    stdin.on('data', onData);
  });
}

async function secret() {
  const [, verb, name] = positionals;
  if (!name || (verb !== 'set' && verb !== 'check')) throw new ConfigError(['usage: mcp-gateway secret set <name> | secret check <name>']);
  if (verb === 'check') {
    say((await keychain.get(name)) ? `"${name}" is in the keychain.` : `"${name}" is not in the keychain.`);
    return;
  }
  const value = await readSecret(`Value for "${name}" (input hidden): `);
  await keychain.set(name, value);
  if ((await keychain.get(name)) !== value) throw new Error(`"${name}" was stored but could not be read back; check your keychain`);
  say(`Stored "${name}". Use it in mcp-gateway.json as "keychain:${name}".`);
}

const command = positionals[0] ?? 'serve';
async function config() {
  const file = configFile();
  if (!values.host) {
    say(`usage: mcp-gateway config --host <${Object.keys(HOSTS).join(' | ')}> --config <file>`);
    return;
  }
  const parsed = await loadConfig(file); // only a reviewed, valid config is worth installing
  const { title, where, snippet } = hostSnippet(values.host, { configPath: path.resolve(file), version: await ownVersion() });
  say(`${title} — ${where}:\n`);
  process.stdout.write(`${snippet}\n`);
  say('\nThe tools\' keys are not in this snippet: store each with `mcp-gateway secret set <name>` and reference it as keychain:<name>.');
  say(`\n${directAccessWarning(title, Object.keys(parsed.upstreams))}`);
}

async function extension() {
  const file = configFile();
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const parsed = await loadConfig(file); // refuses an unreviewed or invalid config
  const agentFile = JSON.parse(await readFile(parsed.agentConfig, 'utf8'));
  // Upstreams that came from the catalog get its credential titles ("Notion integration token"), the rest generic ones.
  const catalog = [...(await loadCatalog()).values()];
  const fields = credentialFields(catalog, catalogPicksIn(catalog, raw));
  const plan = planExtension({ raw, agentFile, version: await ownVersion(), agentName: values.name, fields });
  for (const w of plan.warnings) say(`warning: ${w}`);
  const out = values.out ?? `${plan.manifest.name}.mcpb`;
  if (values.base) {
    // A released base bundle (docs/releasing.md): compose locally, no install and no packer.
    await writeFile(out, composeExtension(new Uint8Array(await readFile(values.base)), plan));
  } else {
    say(`Building ${out} (fetching the gateway's dependencies and the mcpb packer)…`);
    await buildExtension(plan, { outFile: out });
  }
  say(`Built ${out}. Double-click it to install in Claude Desktop; it will ask for ${Object.keys(plan.manifest.user_config ?? {}).length} credential(s), which Claude stores securely. Nothing secret is inside the file.`);
  // The fence at the source: what each catalog service's own credential should be allowed, for the tools this config uses.
  const toolPicks = catalogPicksIn(catalog, raw).map(({ id }) => ({
    id,
    tools: Object.keys(raw.tools ?? {}).filter((k) => k.startsWith(`${id}.`)).map((k) => k.slice(id.length + 1)),
  }));
  for (const s of serviceSetupFor(catalog, toolPicks)) {
    say(`\n${s.server}: when you create the credential (${s.where}), turn on only: ${s.capabilities.join(', ')}.`);
    say(s.scope);
  }
  say(`\n${directAccessWarning('Claude Desktop', Object.keys(raw.upstreams ?? {}))}`);
}

async function ownVersion() {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  return String(pkg.version);
}

const run = { serve, init, secret, token, config, extension }[command];
if (!run) {
  say(`unknown command "${command}" — use serve, init, secret, token, config or extension`);
  process.exit(2);
}
run().catch((err) => {
  if (err instanceof ConfigError || err instanceof SecretError) log({ event: 'fatal', message: err.message });
  else log({ event: 'fatal', message: err instanceof Error ? err.stack ?? err.message : String(err) });
  process.exit(1);
});
