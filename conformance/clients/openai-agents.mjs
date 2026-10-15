// The OpenAI Agents SDK (JavaScript) driving the gateway as an agent would: its own MCPServerStdio lists the tools and
// calls them. No model is involved; the SDK's MCP client is what is under test. Prints { tools, results } as JSON.
import { readFileSync } from 'node:fs';
import { MCPServerStdio } from '@openai/agents';

const spec = JSON.parse(readFileSync(process.env.CONFORMANCE_SPEC ?? '', 'utf8'));
const { tool, cases } = JSON.parse(readFileSync(process.env.CONFORMANCE_CASES ?? '', 'utf8'));

const server = new MCPServerStdio({ name: 'metamynd', command: spec.command, args: spec.args, env: spec.env, clientSessionTimeoutSeconds: 30 });
await server.connect();
try {
  const tools = (await server.listTools()).map((t) => t.name);
  const results = [];
  for (const c of cases) {
    const r = /** @type {any} */ (await server.callTool(tool, c.args));
    // callTool resolves to the result's content (an array of parts) in this SDK; isError travels on the full result when
    // the SDK keeps it, otherwise it is read from the governed text the gateway always writes for a refusal or a hold.
    const parts = Array.isArray(r) ? r : (r?.content ?? []);
    const text = parts.map((/** @type {any} */ p) => p.text ?? '').join('\n');
    results.push({ id: c.id, isError: Array.isArray(r) ? null : Boolean(r?.isError), text });
  }
  console.log(JSON.stringify({ tools, results }));
} finally {
  await server.close();
}
