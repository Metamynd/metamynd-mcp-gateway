// Conformance (docs/design.md §10): the same governed calls, made through real framework clients, must get the same
// verdicts and run the upstream the same number of times. Each client starts the gateway itself, as that framework
// would, over stdio; MetaMynd is a fake HTTP gate with fixed rules (conformance/fake-gate-server.mjs), the upstream a
// real payment server that records every call it runs.
//
//   node conformance/run.mjs                 every client whose framework is installed
//   CONFORMANCE_REQUIRE_ALL=1 node ...       fail if any client's framework is missing (CI)
//
// The agent file has no key: the gateway reads it from the "agentKey" reference in mcp-gateway.json, as a folder set up
// from the MetaMynd dashboard does.
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemaHashOf } from '../src/schema-hash.mjs';
import { testAgent } from '../test/fake-gate.mjs';
import { PAY_TOOL } from '../test/fixtures/upstream.mjs';
import { startFakeGate } from './fake-gate-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const casesFile = path.join(here, 'cases.json');
const { tool, cases } = JSON.parse(readFileSync(casesFile, 'utf8'));
// Async: the fake gate answers from THIS process, so a synchronous child run would block it and every call time out.
const run = async (/** @type {string} */ cmd, /** @type {string[]} */ args, /** @type {NodeJS.ProcessEnv} */ env) => (await promisify(execFile)(cmd, args, { env, encoding: 'utf8', maxBuffer: 1 << 22 })).stdout;
const python = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');

/** @type {Array<{ name: string, available: () => boolean, run: (env: NodeJS.ProcessEnv) => Promise<string> }>} */
const CLIENTS = [
  {
    name: 'MCP TypeScript SDK',
    available: () => true,
    run: (env) => run(process.execPath, [path.join(here, 'clients', 'mcp-sdk.mjs')], env),
  },
  {
    name: 'OpenAI Agents SDK (JavaScript)',
    available: () => { try { import.meta.resolve('@openai/agents'); return true; } catch { return false; } },
    run: (env) => run(process.execPath, [path.join(here, 'clients', 'openai-agents.mjs')], env),
  },
  {
    name: 'OpenAI Agents SDK (Python)',
    available: () => spawnSync(python, ['-c', 'import agents.mcp'], { stdio: 'ignore' }).status === 0,
    run: (env) => run(python, [path.join(here, 'clients', 'openai_agents_client.py')], env),
  },
  {
    name: 'LangChain / LangGraph (langchain-mcp-adapters)',
    available: () => spawnSync(python, ['-c', 'import langchain_mcp_adapters'], { stdio: 'ignore' }).status === 0,
    run: (env) => run(python, [path.join(here, 'clients', 'langchain_client.py')], env),
  },
];

/** What a governed result says, independent of how each framework wraps it. */
function verdictOf(/** @type {{ isError: boolean | null, text: string }} */ r) {
  const refused = /MetaMynd refused this call \(([A-Z0-9_]+)\)/.exec(r.text);
  if (refused) return `refused:${refused[1]}`;
  if (/MetaMynd is holding this call/.test(r.text)) return 'held';
  if (/^Not sent:|Not sent: /.test(r.text)) return 'not-sent';
  if (r.isError === true) return `error:${r.text.slice(0, 80)}`;
  return /paid with key present/.test(r.text) ? 'ok' : `unexpected:${r.text.slice(0, 80)}`;
}

const gate = await startFakeGate();
const dir = mkdtempSync(path.join(os.tmpdir(), 'mcpgw-conformance-'));
const { agentDid, agentKey } = await testAgent();
writeFileSync(path.join(dir, 'agent.metamynd.json'), JSON.stringify({ apiBase: gate.url, agentDid }));
writeFileSync(path.join(dir, 'mcp-gateway.json'), JSON.stringify({
  agentConfig: './agent.metamynd.json',
  agentKey: '${MCPGW_CONFORMANCE_AGENT_KEY}',
  upstreams: { payments: { command: process.execPath, args: [path.join(root, 'test', 'fixtures', 'upstream.mjs'), 'serve'], env: { API_KEY: '${PAY_KEY}', RAN_FILE: '${RAN_FILE}' } } },
  tools: { 'payments.create_payment': { action: 'payment.create', amount: 'amount', currency: 'currency', merchant: 'payee', allowedArgs: ['amount', 'currency', 'payee'], effect: 'write', schemaHash: schemaHashOf(PAY_TOOL) } },
}));

let failed = false;
const rows = [];
try {
  for (const client of CLIENTS) {
    if (!client.available()) {
      rows.push({ client: client.name, outcome: 'not installed' });
      if (process.env.CONFORMANCE_REQUIRE_ALL === '1') failed = true;
      continue;
    }
    const slug = client.name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
    const ranFile = path.join(dir, `ran-${slug}.log`);
    const gatewayEnv = {
      PAY_KEY: 'test-key',
      RAN_FILE: ranFile,
      MCPGW_CONFORMANCE_AGENT_KEY: agentKey,
      PATH: process.env.PATH ?? '',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    const specFile = path.join(dir, `spec-${slug}.json`);
    writeFileSync(specFile, JSON.stringify({
      command: process.execPath,
      args: [path.join(root, 'src', 'cli.mjs'), '--config', path.join(dir, 'mcp-gateway.json'), '--state-dir', path.join(dir, `state-${slug}`)],
      env: gatewayEnv,
    }));
    const before = gate.state.authorizations.length;
    const bundlesBefore = gate.state.bundleFetches;
    const capturesBefore = gate.state.captures.length;
    const reportsBefore = gate.state.localReports;
    let out;
    try {
      out = await client.run({ ...process.env, CONFORMANCE_SPEC: specFile, CONFORMANCE_CASES: casesFile, NODE_NO_WARNINGS: '1' });
    } catch (err) {
      failed = true;
      rows.push({ client: client.name, outcome: `client failed: ${/** @type {Error} */ (err).message.split('\n')[0]}` });
      continue;
    }
    const report = JSON.parse(out.trim().split('\n').pop() ?? '{}');
    const problems = [];
    if (JSON.stringify(report.tools) !== JSON.stringify([tool])) problems.push(`tools ${JSON.stringify(report.tools)}`);
    for (const c of cases) {
      const r = report.results.find((/** @type {any} */ x) => x.id === c.id);
      const got = r ? verdictOf(r) : 'missing';
      if (got !== c.expect) problems.push(`${c.id}: expected ${c.expect}, got ${got}`);
    }
    const ran = existsSync(ranFile) ? readFileSync(ranFile, 'utf8').trim().split('\n').filter(Boolean).length : 0;
    if (ran !== 1) problems.push(`the upstream ran ${ran} time(s); only the allowed call may run`);
    const asked = gate.state.authorizations.length - before;
    if (asked !== 3) problems.push(`MetaMynd was asked ${asked} time(s); the smuggled call must never be sent`);
    // Every call is decided AT THE GATE (design §3.1, decision 4): never from a local bundle, never merely reported.
    if (gate.state.bundleFetches !== bundlesBefore) problems.push('the guard fetched the policy bundle: it decided locally instead of at the gate');
    if (gate.state.localReports !== reportsBefore) problems.push('a decision was only reported to MetaMynd, not made by the gate');
    if (gate.state.captures.length - capturesBefore !== 1) problems.push(`captured ${gate.state.captures.length - capturesBefore} hold(s); the allowed call's must be captured`);
    if (problems.length) failed = true;
    rows.push({ client: client.name, outcome: problems.length ? `FAIL: ${problems.join('; ')}` : 'identical verdicts' });
  }
} finally {
  await gate.close();
}

for (const r of rows) console.log(`${r.outcome === 'identical verdicts' ? 'ok  ' : r.outcome === 'not installed' ? 'skip' : 'FAIL'} ${r.client}: ${r.outcome}`);
console.log(`cases: ${cases.map((/** @type {any} */ c) => `${c.id} → ${c.expect}`).join(', ')}`);
process.exit(failed ? 1 : 0);
