#!/usr/bin/env node
// mcp-gateway — start the gateway over stdio for an MCP host (Claude Desktop, Cursor, VS Code, …).
//
//   mcp-gateway --config <mcp-gateway.json> [--state-dir <dir>]
//   MCP_GATEWAY_CONFIG=<file> mcp-gateway
//
// stdout carries the MCP protocol, so everything the gateway reports goes to stderr, which hosts log.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createGuardFromConfig } from '@metamynd/agentsafe-guard';
import { ConfigError, loadConfig } from './config.mjs';
import { createGatewayServer } from './gateway.mjs';
import { createGovernance } from './governance.mjs';
import { openJournal } from './journal.mjs';
import { SecretError } from './secrets.mjs';
import { connectUpstreams, listAllTools, reconcileTools } from './upstreams.mjs';

/** @param {Record<string, unknown>} entry */
const log = (entry) => process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), source: 'metamynd-mcp-gateway', ...entry })}\n`);

async function main() {
  const { values } = parseArgs({ options: { config: { type: 'string' }, 'state-dir': { type: 'string' } } });
  const configFile = values.config ?? process.env.MCP_GATEWAY_CONFIG;
  if (!configFile) throw new ConfigError(['no config: pass --config <mcp-gateway.json> or set MCP_GATEWAY_CONFIG']);
  const config = await loadConfig(configFile);
  for (const w of config.warnings) log({ event: 'warning', message: w });

  // T3: the agent's key must not sit where the AI app could read it. A plaintext key works, but is flagged every start.
  const agentFile = JSON.parse(await readFile(config.agentConfig, 'utf8'));
  if (typeof agentFile.agentKey === 'string' && agentFile.agentKey) {
    log({ event: 'warning', message: `${config.agentConfig} holds the agent's key in plain text; keep it in the signer daemon (keyProvider: "daemon") so no tool the AI can use can read it` });
  }
  const guard = await createGuardFromConfig(config.agentConfig);

  const clients = await connectUpstreams(config, { sources: { env: process.env } });
  /** @type {Map<string, import('./upstreams.mjs').ToolDef[]>} */
  const toolsByUpstream = new Map();
  for (const [name, client] of clients) toolsByUpstream.set(name, await listAllTools(client));
  const { offered, withheld } = reconcileTools(config, toolsByUpstream);
  for (const w of withheld) log({ event: 'withheld', tool: w.tool, reason: w.reason });

  const stateDir = values['state-dir'] ?? path.join(os.homedir(), '.metamynd', 'mcp-gateway');
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

main().catch((err) => {
  if (err instanceof ConfigError || err instanceof SecretError) log({ event: 'fatal', message: err.message });
  else log({ event: 'fatal', message: err instanceof Error ? err.stack ?? err.message : String(err) });
  process.exit(1);
});
