// The gateway's side as an MCP client (docs/design.md §3): connect to every upstream with the credential only the gateway
// holds, read its tools, and decide which mapped tools are offered. A mapped tool is offered only if the upstream still
// has it with exactly the definition that was reviewed (its schemaHash); anything else is withheld and reported (T4).

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { schemaHashOf } from './schema-hash.mjs';
import { SecretError, resolveSecrets } from './secrets.mjs';

/** @typedef {import('./config.mjs').GatewayConfig} GatewayConfig */
/** @typedef {import('./config.mjs').ToolMapping} ToolMapping */
/** @typedef {{ name: string, description?: string, inputSchema?: Record<string, unknown>, [k: string]: unknown }} ToolDef */
/** @typedef {{ listTools(p?: { cursor?: string }): Promise<{ tools: ToolDef[], nextCursor?: string }>, callTool(p: { name: string, arguments?: Record<string, unknown> }): Promise<any>, close(): Promise<void> }} UpstreamClient */

/**
 * Connect to every upstream. Every credential reference is resolved first, so a missing one stops the start before any
 * server is launched.
 * @param {GatewayConfig} config
 * @param {{ sources?: import('./secrets.mjs').SecretSources, clientInfo?: { name: string, version: string }, connect?: (name: string, upstream: import('./config.mjs').Upstream, secrets: Record<string, string>) => Promise<UpstreamClient> }} [opts]
 * @returns {Promise<Map<string, UpstreamClient>>}
 */
export async function connectUpstreams(config, opts = {}) {
  /** @type {string[]} */
  const missing = [];
  /** @type {Record<string, Record<string, string>>} */
  const resolved = {};
  for (const [name, u] of Object.entries(config.upstreams)) {
    const field = 'command' in u ? 'env' : 'headers';
    resolved[name] = await resolveSecrets('command' in u ? u.env : u.headers, `upstreams.${name}.${field}`, opts.sources ?? {}, missing);
  }
  if (missing.length) throw new SecretError(missing);

  const connect = opts.connect ?? defaultConnect(opts.clientInfo ?? { name: 'metamynd-mcp-gateway', version: '0.0.0' });
  /** @type {Map<string, UpstreamClient>} */
  const clients = new Map();
  try {
    for (const [name, u] of Object.entries(config.upstreams)) clients.set(name, await connect(name, u, resolved[name]));
  } catch (err) {
    await Promise.allSettled([...clients.values()].map((c) => c.close()));
    throw err;
  }
  return clients;
}

/** @param {{ name: string, version: string }} clientInfo */
function defaultConnect(clientInfo) {
  return async (/** @type {string} */ _name, /** @type {import('./config.mjs').Upstream} */ u, /** @type {Record<string, string>} */ secrets) => {
    const client = new Client(clientInfo);
    // A local server gets only its own credentials plus the SDK's minimal default environment (PATH, HOME, …) — never
    // the gateway's whole environment, which may hold other servers' keys. Its stderr joins the gateway's own, which the
    // host logs (stdout is the protocol, so nothing else may write there).
    const transport = 'command' in u
      ? new StdioClientTransport({ command: u.command, args: u.args, env: secrets, stderr: 'inherit' })
      : new StreamableHTTPClientTransport(new URL(u.url), { requestInit: { headers: secrets } });
    await client.connect(transport);
    return /** @type {UpstreamClient} */ (/** @type {unknown} */ (client));
  };
}

/**
 * Every tool an upstream offers, following pagination.
 * @param {UpstreamClient} client
 * @returns {Promise<ToolDef[]>}
 */
export async function listAllTools(client) {
  /** @type {ToolDef[]} */
  const all = [];
  let cursor;
  for (let page = 0; page < 100; page++) {
    const res = await client.listTools(cursor ? { cursor } : undefined);
    all.push(...res.tools);
    if (!res.nextCursor) break;
    cursor = res.nextCursor;
  }
  return all;
}

/**
 * Decide what is offered: each mapped tool whose upstream still has it with the reviewed definition.
 * @param {GatewayConfig} config
 * @param {Map<string, ToolDef[]>} toolsByUpstream
 * @returns {{ offered: Array<{ mapping: ToolMapping, def: ToolDef }>, withheld: Array<{ tool: string, reason: string }> }}
 */
export function reconcileTools(config, toolsByUpstream) {
  /** @type {Array<{ mapping: ToolMapping, def: ToolDef }>} */
  const offered = [];
  /** @type {Array<{ tool: string, reason: string }>} */
  const withheld = [];
  for (const [key, mapping] of config.tools) {
    const def = (toolsByUpstream.get(mapping.upstream) ?? []).find((t) => t.name === mapping.tool);
    if (!def) { withheld.push({ tool: key, reason: `the "${mapping.upstream}" server no longer offers "${mapping.tool}"` }); continue; }
    const hash = schemaHashOf(def);
    if (hash !== mapping.schemaHash) {
      withheld.push({ tool: key, reason: `its definition changed since it was reviewed (now ${hash}); review it again before it is offered` });
      continue;
    }
    offered.push({ mapping, def });
  }
  return { offered, withheld };
}
