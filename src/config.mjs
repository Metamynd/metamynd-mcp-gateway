// Load and validate mcp-gateway.json (docs/design.md §4.1). Every problem is reported at once, so a user fixes the file
// in one pass instead of one error per restart. Nothing here talks to the network or reads a secret: it only checks that
// the file is well formed and keeps the design's rules —
//   - every upstream holds its own credential, as a reference, never a literal secret (decision 2);
//   - every governed tool is mapped and reviewed, and pinned to the definition that was reviewed (decision 4, T4).

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** The separator between an upstream's name and its tool's name in what the host sees: `<upstream>__<tool>`. */
export const NAME_SEPARATOR = '__';
/** The longest exposed tool name: with a short host key it keeps server + tool under Cursor's ~60 (docs/hosts.md). */
export const MAX_EXPOSED_NAME = 48;
/** Above this many governed tools some hosts drop tools (Cursor reports ~40 in total, docs/hosts.md): a warning. */
export const TOOL_COUNT_WARNING = 40;
/** Hosts time a tool call out at ~60 s (docs/hosts.md), so the gateway never waits longer than this for an approval. */
export const MAX_ESCALATION_WAIT_MS = 30_000;
const EXPOSED_NAME_RE = /^[A-Za-z0-9_-]+$/;
const UPSTREAM_NAME_RE = /^[a-z][a-z0-9-]{0,30}$/;
const SCHEMA_HASH_RE = /^sha256:[0-9a-f]{64}$/;
const RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
const ON_TOOL_ERROR = new Set(['capture', 'void']);
/** A secret is referenced, never written: `${VAR}` (environment) or `keychain:<name>` (the OS keychain). */
const SECRET_REF_RE = /\$\{[A-Z_][A-Z0-9_]*\}|^keychain:[A-Za-z0-9._-]+$/;

/**
 * @typedef {{ command: string, args: string[], env: Record<string, string> } | { url: string, headers: Record<string, string> }} Upstream
 * @typedef {{
 *   upstream: string, tool: string, exposedName: string, action: string,
 *   amount?: string, currency?: string, merchant?: string,
 *   allowedArgs: string[], context: Record<string, unknown>, schemaHash: string, onToolError: 'capture' | 'void'
 * }} ToolMapping
 * @typedef {{ agentConfig: string, upstreams: Record<string, Upstream>, tools: Map<string, ToolMapping>, escalationWaitMs: number, warnings: string[] }} GatewayConfig
 */

export class ConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`mcp-gateway.json has ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * Read and validate a config file. Relative paths in it (agentConfig) resolve against the file's own directory.
 * @param {string} file
 * @returns {Promise<GatewayConfig>}
 */
export async function loadConfig(file) {
  let raw;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new ConfigError([`cannot read ${file}: ${/** @type {Error} */ (err).message}`]);
  }
  return parseConfig(raw, path.dirname(path.resolve(file)));
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Validate an already-parsed config.
 * @param {unknown} raw
 * @param {string} [baseDir] directory relative paths resolve against
 * @returns {GatewayConfig}
 */
export function parseConfig(raw, baseDir = process.cwd()) {
  /** @type {string[]} */
  const problems = [];
  if (!isObject(raw)) throw new ConfigError(['the file must contain a JSON object']);
  const { agentConfig, upstreams } = parseHead(raw, baseDir, problems);

  /** @type {Map<string, ToolMapping>} */
  const tools = new Map();
  if (!isObject(raw.tools) || Object.keys(raw.tools).length === 0) {
    problems.push('"tools" must map at least one tool (run `mcp-gateway init` to draft the mapping)');
  } else {
    for (const [key, t] of Object.entries(raw.tools)) {
      const mapping = parseTool(key, t, upstreams, problems);
      if (mapping) {
        if ([...tools.values()].some((m) => m.exposedName === mapping.exposedName)) problems.push(`tools.${key}: exposed name "${mapping.exposedName}" collides with another tool`);
        else tools.set(key, mapping);
      }
    }
  }
  for (const name of Object.keys(upstreams)) {
    if (![...tools.values()].some((m) => m.upstream === name)) problems.push(`upstreams.${name}: no tool of it is mapped, so it would offer nothing`);
  }

  const escalationWaitMs = raw.escalationWaitMs ?? 0;
  if (typeof escalationWaitMs !== 'number' || !Number.isInteger(escalationWaitMs) || escalationWaitMs < 0 || escalationWaitMs > MAX_ESCALATION_WAIT_MS) {
    problems.push(`"escalationWaitMs": whole milliseconds from 0 to ${MAX_ESCALATION_WAIT_MS} (apps give up on a tool call after about a minute)`);
  }

  if (problems.length) throw new ConfigError(problems);
  /** @type {string[]} */
  const warnings = [];
  if (tools.size > TOOL_COUNT_WARNING) {
    warnings.push(`${tools.size} tools are governed; some apps show only about ${TOOL_COUNT_WARNING} in total, so offer fewer if tools go missing`);
  }
  return { agentConfig, upstreams, tools, escalationWaitMs: /** @type {number} */ (escalationWaitMs), warnings };
}

/**
 * Validate only what `mcp-gateway init` needs before any tool is mapped: the agent file and the upstreams.
 * @param {unknown} raw
 * @param {string} [baseDir]
 * @returns {{ agentConfig: string, upstreams: Record<string, Upstream> }}
 */
export function parseDraftConfig(raw, baseDir = process.cwd()) {
  /** @type {string[]} */
  const problems = [];
  if (!isObject(raw)) throw new ConfigError(['the file must contain a JSON object']);
  const head = parseHead(raw, baseDir, problems);
  if (problems.length) throw new ConfigError(problems);
  return head;
}

/**
 * The agent file and the upstreams, shared by the full and the draft parse.
 * @param {Record<string, unknown>} raw
 * @param {string} baseDir
 * @param {string[]} problems
 */
function parseHead(raw, baseDir, problems) {
  const agentConfig = typeof raw.agentConfig === 'string' && raw.agentConfig.trim() ? path.resolve(baseDir, raw.agentConfig) : '';
  if (!agentConfig) problems.push('"agentConfig" must name the agent file (agent.metamynd.json)');

  /** @type {Record<string, Upstream>} */
  const upstreams = {};
  if (!isObject(raw.upstreams) || Object.keys(raw.upstreams).length === 0) {
    problems.push('"upstreams" must list at least one MCP server');
  } else {
    for (const [name, u] of Object.entries(raw.upstreams)) {
      const where = `upstreams.${name}`;
      if (!UPSTREAM_NAME_RE.test(name)) problems.push(`${where}: a name is lower-case letters, digits and "-", starting with a letter, at most 31 characters`);
      if (!isObject(u)) { problems.push(`${where}: must be an object`); continue; }
      const parsed = parseUpstream(u, where, problems);
      if (parsed) upstreams[name] = parsed;
    }
  }
  return { agentConfig, upstreams };
}

/**
 * @param {Record<string, unknown>} u
 * @param {string} where
 * @param {string[]} problems
 * @returns {Upstream | null}
 */
function parseUpstream(u, where, problems) {
  const isStdio = u.command !== undefined;
  const isHttp = u.url !== undefined;
  if (isStdio === isHttp) { problems.push(`${where}: give either "command" (a local server) or "url" (a remote one)`); return null; }
  /** @type {Record<string, string>} */
  const secrets = {};
  const field = isStdio ? 'env' : 'headers';
  const bag = u[field] ?? {};
  if (!isObject(bag)) { problems.push(`${where}.${field}: must be an object`); return null; }
  for (const [k, v] of Object.entries(bag)) {
    if (typeof v !== 'string') { problems.push(`${where}.${field}.${k}: must be a string`); continue; }
    secrets[k] = v;
  }
  // Decision 2: the gateway holds the upstream's credential. One with no credential reference is not governed by anything
  // but the gateway's say-so, and anyone with the server's address could call it directly.
  const refs = Object.values(secrets).filter((v) => SECRET_REF_RE.test(v));
  if (refs.length === 0) problems.push(`${where}.${field}: must carry the server's credential as a reference — \${VAR} or keychain:<name> — so the gateway, not the AI app, holds it`);
  for (const [k, v] of Object.entries(secrets)) {
    if (!SECRET_REF_RE.test(v) && looksSecret(k, v)) problems.push(`${where}.${field}.${k}: looks like a secret written into the file; use \${VAR} or keychain:<name> instead`);
  }
  if (isStdio) {
    if (typeof u.command !== 'string' || !u.command.trim()) { problems.push(`${where}.command: must be a non-empty string`); return null; }
    const args = u.args ?? [];
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) { problems.push(`${where}.args: must be a list of strings`); return null; }
    return { command: u.command, args, env: secrets };
  }
  let url;
  try { url = new URL(String(u.url)); } catch { problems.push(`${where}.url: not a valid URL`); return null; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) problems.push(`${where}.url: must be https (plain http only to this machine)`);
  return { url: url.href, headers: secrets };
}

/** A literal value under a secret-sounding name, long enough to be a real key. */
function looksSecret(/** @type {string} */ name, /** @type {string} */ value) {
  return /key|token|secret|password|authorization|bearer/i.test(name) && value.replace(/^Bearer\s+/i, '').length >= 12;
}

/**
 * @param {string} key `<upstream>.<tool>`
 * @param {unknown} t
 * @param {Record<string, Upstream>} upstreams
 * @param {string[]} problems
 * @returns {ToolMapping | null}
 */
function parseTool(key, t, upstreams, problems) {
  const where = `tools.${key}`;
  const dot = key.indexOf('.');
  const upstream = dot > 0 ? key.slice(0, dot) : '';
  const tool = dot > 0 ? key.slice(dot + 1) : '';
  if (!upstream || !tool) { problems.push(`${where}: a tool is named "<upstream>.<tool>"`); return null; }
  if (!(upstream in upstreams)) { problems.push(`${where}: no upstream named "${upstream}"`); return null; }
  if (!isObject(t)) { problems.push(`${where}: must be an object`); return null; }
  if (t.review === true) { problems.push(`${where}: still marked "review": true — check the drafted mapping, then remove the flag`); return null; }

  const exposedName = `${upstream}${NAME_SEPARATOR}${tool}`;
  if (exposedName.length > MAX_EXPOSED_NAME || !EXPOSED_NAME_RE.test(exposedName)) {
    problems.push(`${where}: the name the app sees, "${exposedName}", must be at most ${MAX_EXPOSED_NAME} characters of letters, digits, "_" and "-"`);
  }
  const action = typeof t.action === 'string' ? t.action.trim() : '';
  if (!action || action.includes('|')) problems.push(`${where}.action: must be the mandate action this tool performs (no "|")`);

  const allowedArgs = Array.isArray(t.allowedArgs) && t.allowedArgs.every((a) => typeof a === 'string') ? /** @type {string[]} */ (t.allowedArgs) : null;
  if (!allowedArgs) problems.push(`${where}.allowedArgs: must list the arguments the tool accepts ([] for none)`);

  /** @type {Partial<Record<'amount'|'currency'|'merchant', string>>} */
  const value = {};
  for (const f of /** @type {const} */ (['amount', 'currency', 'merchant'])) {
    if (t[f] === undefined) continue;
    if (typeof t[f] !== 'string' || !t[f]) { problems.push(`${where}.${f}: must name the argument that carries it`); continue; }
    const argName = /** @type {string} */ (t[f]);
    if (allowedArgs && !allowedArgs.includes(argName.split('.')[0])) problems.push(`${where}.${f}: "${argName}" is not in allowedArgs`);
    value[f] = argName;
  }
  if (value.amount && !value.currency) problems.push(`${where}: a tool that moves an amount must also map its currency`);

  const context = t.context ?? {};
  if (!isObject(context)) problems.push(`${where}.context: must be an object`);
  else if (context.riskLevel !== undefined && !RISK_LEVELS.has(/** @type {string} */ (context.riskLevel))) problems.push(`${where}.context.riskLevel: one of low, medium, high, critical`);

  const schemaHash = typeof t.schemaHash === 'string' ? t.schemaHash : '';
  if (!SCHEMA_HASH_RE.test(schemaHash)) problems.push(`${where}.schemaHash: must pin the reviewed tool definition (sha256:<64 hex>); run \`mcp-gateway init\``);

  const onToolError = t.onToolError ?? 'capture';
  if (!ON_TOOL_ERROR.has(/** @type {string} */ (onToolError))) problems.push(`${where}.onToolError: "capture" (default) or "void"`);

  if (!allowedArgs || !isObject(context)) return null;
  return {
    upstream, tool, exposedName, action, ...value, allowedArgs,
    context, schemaHash, onToolError: /** @type {'capture'|'void'} */ (onToolError),
  };
}
