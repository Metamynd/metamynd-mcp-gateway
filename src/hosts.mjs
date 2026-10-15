// `mcp-gateway config --host <name>`: the snippet that adds the gateway to an AI app, from docs/hosts.md. Always a
// scoped, pinned package (`@metamynd/mcp-gateway@x.y.z`), never a bare name a squatter could take. Credentials are not in
// any snippet: the gateway reads them from the OS keychain (`keychain:<name>`), so the app's own config holds no secret.

export const PACKAGE = '@metamynd/mcp-gateway';
export const SERVER_KEY = 'metamynd';

/** @typedef {{ configPath: string, version: string }} SnippetInput */

/** @param {SnippetInput} i */
const npxArgs = (i) => ['-y', `${PACKAGE}@${i.version}`, '--config', i.configPath];
const json = (/** @type {unknown} */ v) => JSON.stringify(v, null, 2);

/** @type {Record<string, { title: string, where: string, render: (i: SnippetInput) => string }>} */
export const HOSTS = {
  'claude-desktop': {
    title: 'Claude Desktop',
    where: 'claude_desktop_config.json (macOS: ~/Library/Application Support/Claude/, Windows: %APPDATA%\\Claude\\), merged into "mcpServers"; then quit and reopen Claude. Easier: `mcp-gateway extension` builds a one-click extension.',
    render: (i) => json({ mcpServers: { [SERVER_KEY]: { command: 'npx', args: npxArgs(i) } } }),
  },
  'claude-code': {
    title: 'Claude Code',
    where: 'run in a terminal',
    render: (i) => `claude mcp add --transport stdio ${SERVER_KEY} -- npx ${npxArgs(i).map(quote).join(' ')}`,
  },
  cursor: {
    title: 'Cursor',
    where: '.cursor/mcp.json in the project, or ~/.cursor/mcp.json for every project, merged into "mcpServers"',
    render: (i) => json({ mcpServers: { [SERVER_KEY]: { type: 'stdio', command: 'npx', args: npxArgs(i) } } }),
  },
  vscode: {
    title: 'VS Code (Copilot agent mode)',
    where: '.vscode/mcp.json, merged into "servers" (note: "servers", not "mcpServers")',
    render: (i) => json({ servers: { [SERVER_KEY]: { type: 'stdio', command: 'npx', args: npxArgs(i) } } }),
  },
  'openai-agents-python': {
    title: 'OpenAI Agents SDK (Python)',
    where: 'your agent code; the SDK\'s 5-second default timeout is too short for a governed call, so it is raised here',
    render: (i) => [
      'from agents.mcp import MCPServerStdio',
      '',
      'metamynd = MCPServerStdio(',
      `    params={"command": "npx", "args": ${JSON.stringify(npxArgs(i))}},`,
      '    client_session_timeout_seconds=30,',
      ')',
      '# async with metamynd: agent = Agent(..., mcp_servers=[metamynd])',
    ].join('\n'),
  },
  'openai-agents-js': {
    title: 'OpenAI Agents SDK (JavaScript)',
    where: 'your agent code',
    render: (i) => [
      "import { MCPServerStdio } from '@openai/agents';",
      '',
      `const metamynd = new MCPServerStdio({ name: '${SERVER_KEY}', fullCommand: ${JSON.stringify(`npx ${npxArgs(i).map(quote).join(' ')}`)} });`,
      '// await metamynd.connect(); const agent = new Agent({ ..., mcpServers: [metamynd] });',
    ].join('\n'),
  },
  langchain: {
    title: 'LangChain / LangGraph (langchain[mcp] >= 1.4)',
    where: 'the MCP connection config you pass to LangChain\'s MCP adapter',
    render: (i) => json({ [SERVER_KEY]: { transport: 'stdio', command: 'npx', args: npxArgs(i) } }),
  },
};

/** Quote an argument for a POSIX shell / Windows command line when it needs it. */
function quote(/** @type {string} */ a) {
  return /^[A-Za-z0-9_./:@=-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, '\\$1')}"`;
}

/**
 * T1 (docs/design.md §6): a server the app can still reach directly is not governed. Every setup ends by saying so,
 * naming the servers the gateway now fronts.
 * @param {string} appTitle e.g. "Claude Desktop"
 * @param {string[]} servers e.g. ["Notion"]
 */
export function directAccessWarning(appTitle, servers) {
  const one = servers.length === 1;
  const list = servers.length ? servers.join(', ') : 'these tools';
  return `If ${list} ${one ? 'is' : 'are'} also set up in ${appTitle} directly (its own entry in the app's MCP settings, an extension or a connector), remove ${one ? 'it' : 'them'} entirely: disconnecting is not enough, because the app can still offer ${one ? 'it' : 'them'} to the AI. While the app can reach a server directly, the AI can use it without MetaMynd.`;
}

/**
 * @param {string} host
 * @param {SnippetInput} input
 */
export function hostSnippet(host, input) {
  const h = HOSTS[host];
  if (!h) throw new Error(`unknown host "${host}"; one of: ${Object.keys(HOSTS).join(', ')}`);
  return { title: h.title, where: h.where, snippet: h.render(input) };
}
