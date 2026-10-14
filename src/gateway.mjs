// The gateway's side as an MCP server (docs/design.md §3): the AI app sees ONE server whose tools are the offered,
// governed tools of every upstream, named <upstream>__<tool>. Every call goes through governance; nothing is forwarded
// any other way.

import { Server } from '@modelcontextprotocol/server';

/** @typedef {import('./config.mjs').ToolMapping} ToolMapping */
/** @typedef {import('./upstreams.mjs').ToolDef} ToolDef */

export const GOVERNED_NOTE = 'Governed by MetaMynd: this call may be refused or held for approval.';

/**
 * The hints an app is given about a tool (MCP tool annotations), from the reviewer's `effect` ONLY. An upstream's own
 * annotations are never passed on: they are the server's claim about itself, and a server that marks a payment tool
 * read-only would have an app skip its confirmation (docs/hosts.md, decision 6). No effect, no hint: the app applies its
 * own, cautious default.
 * @param {ToolMapping} mapping
 */
export function annotationsFor(mapping) {
  switch (mapping.effect) {
    case 'read': return { readOnlyHint: true };
    case 'write': return { readOnlyHint: false, destructiveHint: false };
    case 'destructive': return { readOnlyHint: false, destructiveHint: true };
    default: return undefined;
  }
}

/**
 * @param {{
 *   offered: Array<{ mapping: ToolMapping, def: ToolDef }>,
 *   governance: { call(mapping: ToolMapping, args: unknown): Promise<import('./governance.mjs').CallToolResult> },
 *   serverInfo?: { name: string, version: string },
 * }} deps
 */
export function createGatewayServer({ offered, governance, serverInfo = { name: 'metamynd', version: '0.0.0' } }) {
  /** @type {Map<string, ToolMapping>} */
  const byName = new Map(offered.map(({ mapping }) => [mapping.exposedName, mapping]));
  const tools = offered.map(({ mapping, def }) => {
    const annotations = annotationsFor(mapping);
    return {
      name: mapping.exposedName,
      description: def.description ? `${GOVERNED_NOTE}\n\n${def.description}` : GOVERNED_NOTE,
      inputSchema: def.inputSchema ?? { type: 'object' },
      ...(annotations ? { annotations } : {}),
    };
  });

  const server = new Server(serverInfo, { capabilities: { tools: {} } });
  // The upstream's schema passes through as reviewed (its schemaHash); the SDK's narrower static type is not re-asserted.
  server.setRequestHandler('tools/list', async () => /** @type {any} */ ({ tools }));
  server.setRequestHandler('tools/call', async (request) => {
    const mapping = byName.get(request.params.name);
    if (!mapping) {
      return { content: [{ type: 'text', text: `No governed tool named "${request.params.name}" is offered.` }], isError: true };
    }
    return /** @type {any} */ (await governance.call(mapping, request.params.arguments ?? {}));
  });
  return server;
}
