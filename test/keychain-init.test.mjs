import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, parseConfig } from '../src/config.mjs';
import { actionFromToolName, draftMapping, draftTools } from '../src/init.mjs';
import { SERVICE, createKeychain } from '../src/keychain.mjs';
import { schemaHashOf } from '../src/schema-hash.mjs';
import { PAY_TOOL } from './fixtures/upstream.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SECRET = 'sk_live_51HxAbCdEf "quoted" $dollar';

/** A fake runner that records each command and answers like the real tool. */
function fakeRunner(answer = (/** @type {string} */ _cmd, /** @type {string[]} */ _args, /** @type {string|undefined} */ _input) => ({ code: 0, stdout: '', stderr: '' })) {
  const calls = /** @type {Array<{ cmd: string, args: string[], input?: string }>} */ ([]);
  /** @type {import('../src/keychain.mjs').Runner} */
  const run = async (cmd, args, input) => { calls.push({ cmd, args, input }); return answer(cmd, args, input); };
  return { calls, run };
}

test('macOS: stored through `security -i` on stdin, hex-encoded — never on a command line', async () => {
  const { calls, run } = fakeRunner((_c, args) => (args[0] === 'find-generic-password' ? { code: 0, stdout: `${SECRET}\n`, stderr: '' } : { code: 0, stdout: '', stderr: '' }));
  const kc = createKeychain({ stateDir: '/unused', platform: 'darwin', run });
  await kc.set('pay', SECRET);
  assert.deepEqual(calls[0].args, ['-i']);
  assert.ok(calls[0].input?.includes(`-X ${Buffer.from(SECRET).toString('hex')}`));
  assert.ok(!calls.some((c) => c.args.join(' ').includes('sk_live')), 'the secret is in no argument');
  assert.equal(await kc.get('pay'), SECRET);
  assert.deepEqual(calls[1].args, ['find-generic-password', '-s', SERVICE, '-a', 'pay', '-w']);
});

test('macOS / Linux: an absent item is undefined, not an error', async () => {
  const absent = fakeRunner(() => ({ code: 44, stdout: '', stderr: 'not found' }));
  assert.equal(await createKeychain({ stateDir: '/x', platform: 'darwin', run: absent.run }).get('nope'), undefined);
  assert.equal(await createKeychain({ stateDir: '/x', platform: 'linux', run: absent.run }).get('nope'), undefined);
});

test('Linux: secret-tool, with the value on stdin', async () => {
  const { calls, run } = fakeRunner();
  await createKeychain({ stateDir: '/x', platform: 'linux', run }).set('pay', SECRET);
  assert.equal(calls[0].cmd, 'secret-tool');
  assert.deepEqual(calls[0].args.slice(-4), ['service', SERVICE, 'account', 'pay']);
  assert.equal(calls[0].input, SECRET);
});

test('names are checked before any command runs', async () => {
  const { calls, run } = fakeRunner();
  await assert.rejects(createKeychain({ stateDir: '/x', platform: 'linux', run }).get('bad name; rm -rf'), /keychain name/);
  assert.equal(calls.length, 0);
});

test('Windows: a real DPAPI round trip (user-scoped), stored as a protected blob', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'mcpgw-kc-'));
  const kc = createKeychain({ stateDir });
  assert.equal(await kc.get('pay'), undefined);
  await kc.set('pay', SECRET);
  assert.equal(await kc.get('pay'), SECRET);
  const blob = await readFile(path.join(stateDir, 'secrets', 'pay.dpapi'), 'utf8');
  assert.ok(!blob.includes('sk_live') && !Buffer.from(blob, 'base64').toString('latin1').includes('sk_live'), 'the file holds no plaintext');
});

test('init drafts: action from the tool name, value fields by name and type, risk from what it moves', () => {
  assert.equal(actionFromToolName('createPayment'), 'create-payment');
  assert.equal(actionFromToolName('list_invoices'), 'list-invoices');
  const pay = draftMapping(PAY_TOOL);
  assert.deepEqual({ ...pay, schemaHash: undefined }, {
    review: true, action: 'create-payment', amount: 'amount', currency: 'currency', merchant: 'payee',
    allowedArgs: ['amount', 'currency', 'payee'], effect: 'write', context: { riskLevel: 'high' }, schemaHash: undefined,
  });
  assert.equal(pay.schemaHash, schemaHashOf(PAY_TOOL));
  const read = draftMapping({ name: 'listInvoices', inputSchema: { type: 'object', properties: { customer: { type: 'string' } } }, annotations: { readOnlyHint: true } });
  assert.equal(read.amount, undefined);
  assert.deepEqual(read.context, { riskLevel: 'low' });
  const noCurrency = draftMapping({ name: 'tip', inputSchema: { type: 'object', properties: { amount: { type: 'number' } } } });
  assert.match(String(noCurrency._note), /no currency argument/);
});

test('init merges: drafts every unmapped tool, keeps reviewed ones, reports changed and vanished tools', () => {
  const raw = { agentConfig: './a.json', upstreams: {}, tools: { 'payments.create_payment': { action: 'pay', schemaHash: 'sha256:old' }, 'payments.gone': { action: 'x' } } };
  const read = { name: 'list_invoices', inputSchema: { type: 'object', properties: {} } };
  const { config, drafted, changed, missing } = draftTools(raw, new Map([['payments', [PAY_TOOL, read]]]));
  assert.deepEqual(drafted, ['payments.list_invoices']);
  assert.deepEqual(changed, [{ tool: 'payments.create_payment', schemaHash: schemaHashOf(PAY_TOOL) }]);
  assert.deepEqual(missing, ['payments.gone']);
  assert.equal(/** @type {any} */ (config.tools)['payments.create_payment'].action, 'pay', 'a reviewed mapping is never overwritten');
});

/** @param {string[]} args @param {{ input?: string, env?: Record<string, string> }} [o] */
function cli(args, o = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [path.join(here, '..', 'src', 'cli.mjs'), ...args], { env: { ...process.env, ...o.env } }, (err, stdout, stderr) => resolve({ code: err ? /** @type {any} */ (err).code : 0, stdout, stderr }));
    child.stdin?.end(o.input ?? '');
  });
}

test('the CLI: init drafts from the real upstream, and the gateway refuses to start until the drafts are reviewed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcpgw-init-'));
  const file = path.join(dir, 'mcp-gateway.json');
  await writeFile(file, JSON.stringify({
    agentConfig: './agent.metamynd.json',
    upstreams: { payments: { command: process.execPath, args: [path.join(here, 'fixtures', 'upstream.mjs'), 'serve'], env: { API_KEY: '${PAY_KEY}' } } },
  }));
  const r = /** @type {any} */ (await cli(['init', '--config', file], { env: { PAY_KEY: 'k' } }));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /\+ payments\.create_payment/);
  const written = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(written.tools['payments.create_payment'].review, true);
  assert.throws(() => parseConfig(written, dir), (e) => e instanceof ConfigError && /still marked "review": true/.test(e.message));
  delete written.tools['payments.create_payment'].review;
  assert.equal(parseConfig(written, dir).tools.size, 1, 'once reviewed, it parses');
});

test('the CLI: secret set reads stdin, stores it, and check never prints it', { skip: process.platform !== 'win32' && 'real keychain only on Windows here' }, async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'mcpgw-sec-'));
  const set = /** @type {any} */ (await cli(['secret', 'set', 'pay', '--state-dir', stateDir], { input: `${SECRET}\n` }));
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.stderr, /Stored "pay"/);
  const check = /** @type {any} */ (await cli(['secret', 'check', 'pay', '--state-dir', stateDir]));
  assert.match(check.stderr, /"pay" is in the keychain/);
  assert.ok(!`${set.stdout}${set.stderr}${check.stdout}${check.stderr}`.includes('sk_live'));
  assert.equal(await createKeychain({ stateDir }).get('pay'), SECRET);
});
