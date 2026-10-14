// A real stdio MCP server for the CLI test: one payment tool. It reports whether it was started with its credential and
// writes a marker file whenever a call reaches it, so the test can prove what ran.
import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

export const PAY_TOOL = { name: 'create_payment', description: 'Pay someone.', inputSchema: { type: 'object', properties: { amount: { type: 'number' }, currency: { type: 'string' }, payee: { type: 'string' } } } };

if (process.argv[2] === 'serve') {
  const server = new Server({ name: 'payments', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => /** @type {any} */ ({ tools: [PAY_TOOL] }));
  server.setRequestHandler('tools/call', async (req) => {
    if (process.env.RAN_FILE) appendFileSync(process.env.RAN_FILE, `${JSON.stringify(req.params.arguments)}\n`);
    return { content: [{ type: 'text', text: `paid with key ${process.env.API_KEY ? 'present' : 'MISSING'}` }] };
  });
  await server.connect(new StdioServerTransport());
}
