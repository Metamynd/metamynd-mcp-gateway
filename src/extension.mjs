// `mcp-gateway extension`: build a one-click Claude Desktop extension (.mcpb) for ONE agent (docs/design.md §5.1,
// docs/hosts.md). Nothing secret goes into the bundle:
//   - every credential the config references (`${VAR}` or `keychain:<name>`) becomes a `sensitive` field Claude Desktop
//     asks for at install and stores securely, passed to the gateway as an environment variable;
//   - the agent's key is removed from the bundled agent file and becomes a sensitive field too (unless the agent signs
//     through the signer daemon, which holds the key itself).
// Claude Desktop ships Node.js, so the extension runs the bundled gateway with no other install.

import { exec, execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_VERSION = '0.2';
export const MCPB_PACKAGE = '@anthropic-ai/mcpb@2.1.2';
export const AGENT_KEY_ENV = 'MCPGW_AGENT_KEY';

const VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const KEYCHAIN_RE = /^keychain:([A-Za-z0-9._-]+)$/;

/** `keychain:payments-api-key` → `MCPGW_SECRET_PAYMENTS_API_KEY` */
const envForKeychain = (/** @type {string} */ name) => `MCPGW_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
/** A user_config key: lower-case letters, digits, "_". */
const fieldFor = (/** @type {string} */ env) => env.toLowerCase();

/**
 * Plan the bundle: the manifest, the config and agent file it carries. Pure.
 * @param {{ raw: Record<string, any>, agentFile: Record<string, any>, version: string, agentName?: string }} input
 */
export function planExtension({ raw, agentFile, version, agentName }) {
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, { title: string, description: string }>} env var → field description */
  const secrets = new Map();
  const upstreams = /** @type {Record<string, any>} */ (JSON.parse(JSON.stringify(raw.upstreams ?? {})));

  for (const [name, u] of Object.entries(upstreams)) {
    const bag = /** @type {Record<string, string>} */ (u.command !== undefined ? (u.env ??= {}) : (u.headers ??= {}));
    for (const [key, value] of Object.entries(bag)) {
      const kc = KEYCHAIN_RE.exec(value);
      if (kc) {
        const env = envForKeychain(kc[1]);
        bag[key] = `\${${env}}`;
        secrets.set(env, { title: `${name}: ${key}`, description: `The ${key} the "${name}" tools need (was keychain:${kc[1]}).` });
        continue;
      }
      for (const m of value.matchAll(VAR_RE)) secrets.set(m[1], { title: `${name}: ${m[1]}`, description: `The ${m[1]} the "${name}" tools need.` });
    }
    if (u.command !== undefined && path.isAbsolute(String(u.command))) {
      warnings.push(`upstreams.${name}.command is a path on this machine (${u.command}); it will not exist on another computer`);
    }
  }

  const daemon = agentFile.keyProvider === 'daemon' || (agentFile.keyProvider && typeof agentFile.keyProvider === 'object');
  const { agentKey, agentKeyEncrypted, ...strippedAgent } = agentFile;
  const needsAgentKey = !daemon;
  if (agentKeyEncrypted && !agentKey) warnings.push('the agent key is passphrase-encrypted; the extension asks for the decrypted key instead');

  /** @type {Record<string, { type: string, title: string, description: string, sensitive?: boolean, required: boolean }>} */
  const userConfig = {};
  /** @type {Record<string, string>} */
  const env = {};
  if (needsAgentKey) {
    userConfig[fieldFor(AGENT_KEY_ENV)] = { type: 'string', title: 'Agent key', description: 'The agent key from your MetaMynd agent file (agent.metamynd.json, "agentKey"). Stored securely by Claude.', sensitive: true, required: true };
    env[AGENT_KEY_ENV] = `\${user_config.${fieldFor(AGENT_KEY_ENV)}}`;
  }
  for (const [name, s] of secrets) {
    userConfig[fieldFor(name)] = { type: 'string', title: s.title, description: s.description, sensitive: true, required: true };
    env[name] = `\${user_config.${fieldFor(name)}}`;
  }

  const slug = String(agentName ?? strippedAgent.agentDid ?? 'agent').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'agent';
  const manifest = {
    manifest_version: MANIFEST_VERSION,
    name: `metamynd-${slug}`,
    display_name: agentName ? `MetaMynd: ${agentName}` : 'MetaMynd governed tools',
    version,
    description: 'Your tools, governed by MetaMynd: every call is checked against the agent\'s mandate, and may be refused or held for approval.',
    author: { name: 'MetaMynd', url: 'https://metamynd.ai' },
    homepage: 'https://github.com/Metamynd/metamynd-mcp-gateway',
    license: 'MIT',
    server: {
      type: 'node',
      entry_point: 'server/src/cli.mjs',
      mcp_config: {
        command: 'node',
        args: ['${__dirname}/server/src/cli.mjs', '--config', '${__dirname}/mcp-gateway.json'],
        env,
      },
    },
    ...(Object.keys(userConfig).length ? { user_config: userConfig } : {}),
  };
  const gatewayConfig = { ...raw, agentConfig: './agent.metamynd.json', upstreams };
  return { manifest, gatewayConfig, agentFile: strippedAgent, warnings, needsAgentKey };
}

/**
 * Run npm / npx. On Windows they are .cmd scripts, which Node only starts through a shell; the command is then built as
 * ONE string with every argument quoted, rather than handing a shell unescaped arguments.
 * @type {(cmd: string, args: string[], cwd: string) => Promise<void>}
 */
const runChecked = (cmd, args, cwd) => new Promise((resolve, reject) => {
  /** @param {Error | null} err @param {unknown} _out @param {unknown} stderr */
  const done = (err, _out, stderr) => (err ? reject(new Error(`${cmd} ${args.join(' ')} failed: ${String(stderr).trim() || err.message}`)) : resolve());
  const opts = { cwd, windowsHide: true, maxBuffer: 16 << 20 };
  if (process.platform !== 'win32') { execFile(cmd, args, opts, done); return; }
  const quoted = [cmd, ...args].map((a) => (/^[A-Za-z0-9_./:@=-]+$/.test(a) ? a : `"${a.replace(/"/g, '""')}"`)).join(' ');
  exec(quoted, opts, done);
});

/**
 * Stage the bundle directory and pack it with the official mcpb CLI.
 * @param {ReturnType<typeof planExtension>} plan
 * @param {{ outFile: string, packageRoot?: string }} opts
 */
export async function buildExtension(plan, { outFile, packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') }) {
  const stage = await mkdtemp(path.join(os.tmpdir(), 'mcpgw-mcpb-'));
  try {
    await writeFile(path.join(stage, 'manifest.json'), `${JSON.stringify(plan.manifest, null, 2)}\n`);
    await writeFile(path.join(stage, 'mcp-gateway.json'), `${JSON.stringify(plan.gatewayConfig, null, 2)}\n`);
    await writeFile(path.join(stage, 'agent.metamynd.json'), `${JSON.stringify(plan.agentFile, null, 2)}\n`);
    const server = path.join(stage, 'server');
    await mkdir(server);
    await cp(path.join(packageRoot, 'src'), path.join(server, 'src'), { recursive: true });
    const pkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
    await writeFile(path.join(server, 'package.json'), `${JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', private: true, dependencies: pkg.dependencies }, null, 2)}\n`);
    await runChecked('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], server);
    await runChecked('npx', ['-y', MCPB_PACKAGE, 'validate', 'manifest.json'], stage);
    await runChecked('npx', ['-y', MCPB_PACKAGE, 'pack', '.', path.resolve(outFile)], stage);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  return outFile;
}
