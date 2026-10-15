// Reference client: the MCP TypeScript SDK, as most JavaScript hosts use it. Prints { tools, results } as JSON.
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const spec = JSON.parse(readFileSync(process.env.CONFORMANCE_SPEC ?? '', 'utf8'));
const { tool, cases } = JSON.parse(readFileSync(process.env.CONFORMANCE_CASES ?? '', 'utf8'));

const client = new Client({ name: 'conformance', version: '0' });
await client.connect(new StdioClientTransport({ command: spec.command, args: spec.args, env: spec.env, stderr: 'ignore' }));
try {
  const tools = (await client.listTools()).tools.map((t) => t.name);
  const results = [];
  for (const c of cases) {
    const r = await client.callTool({ name: tool, arguments: c.args });
    const text = (r.content ?? []).map((/** @type {any} */ p) => p.text ?? '').join('\n');
    results.push({ id: c.id, isError: Boolean(r.isError), text });
  }
  console.log(JSON.stringify({ tools, results }));
} finally {
  await client.close();
}
