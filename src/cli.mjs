#!/usr/bin/env node
// mcp-gateway — the MetaMynd MCP gateway.
//
//   mcp-gateway [serve] --config <mcp-gateway.json> [--state-dir <dir>]   run it for an AI app, over stdio
//   mcp-gateway init --config <mcp-gateway.json>                         draft the mapping for every upstream tool
//   mcp-gateway secret set <name>                                        store a credential in the OS keychain
//   mcp-gateway secret check <name>                                      say whether it is there (never prints it)
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
import { createGovernance } from './governance.mjs';
import { draftTools } from './init.mjs';
import { openJournal } from './journal.mjs';
import { createKeychain } from './keychain.mjs';
import { SecretError } from './secrets.mjs';
import { connectUpstreams, listAllTools, reconcileTools } from './upstreams.mjs';

/** @param {Record<string, unknown>} entry */
const log = (entry) => process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), source: 'metamynd-mcp-gateway', ...entry })}\n`);
/** @param {string} line */
const say = (line) => process.stderr.write(`${line}\n`);

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { config: { type: 'string' }, 'state-dir': { type: 'string' } },
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
  const config = await loadConfig(configFile());
  for (const w of config.warnings) log({ event: 'warning', message: w });

  // T3: the agent's key must not sit where the AI app could read it. A plaintext key works, but is flagged every start.
  const agentFile = JSON.parse(await readFile(config.agentConfig, 'utf8'));
  if (typeof agentFile.agentKey === 'string' && agentFile.agentKey) {
    log({ event: 'warning', message: `${config.agentConfig} holds the agent's key in plain text; keep it in the signer daemon (keyProvider: "daemon") so no tool the AI can use can read it` });
  }
  const guard = await createGuardFromConfig(config.agentConfig);

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
  const server = createGatewayServer({ offered, governance });
  await server.connect(new StdioServerTransport());
  log({ event: 'ready', agentDid: guard.agentDid, offered: offered.length, withheld: withheld.length, upstreams: clients.size });

  const shutdown = async () => {
    await Promise.allSettled([...clients.values()].map((c) => c.close()));
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
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
const run = { serve, init, secret }[command];
if (!run) {
  say(`unknown command "${command}" — use serve, init or secret`);
  process.exit(2);
}
run().catch((err) => {
  if (err instanceof ConfigError || err instanceof SecretError) log({ event: 'fatal', message: err.message });
  else log({ event: 'fatal', message: err instanceof Error ? err.stack ?? err.message : String(err) });
  process.exit(1);
});
