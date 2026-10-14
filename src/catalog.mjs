// The curated catalog (catalog/<id>.json): MCP servers MetaMynd has reviewed, each pinned to an exact package version,
// with every tool's plain-language summary, the action an owner grants, the effect apps are told, its risk level and
// the hash of the definition that was reviewed. The MetaMynd dashboard builds a gateway config from the tools an owner
// picks (configFromCatalog), so a non-technical owner never drafts or reviews a mapping themselves. CI re-checks every
// hash against the real pinned server (scripts/catalog-verify.mjs), so an entry cannot drift from what actually runs.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, parseConfig } from './config.mjs';

export const CATALOG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'catalog');
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
const PIN_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * @typedef {{ summary: string, action: string, effect: 'read'|'write'|'destructive', allowedArgs: string[], context: Record<string, unknown>, schemaHash: string, amount?: string, currency?: string, merchant?: string, onToolError?: string }} CatalogTool
 * @typedef {{ id: string, name: string, description: string, homepage?: string, server: { package: string, version: string, args?: string[] },
 *   credentials: Array<{ env: string, title: string, description: string }>, actions: Record<string, string>,
 *   probeEnv: Record<string, string>, reviewed: { by: string, on: string }, tools: Record<string, CatalogTool> }} CatalogEntry
 */

/**
 * Problems with one entry, checked as the gateway itself would check the config it produces.
 * @param {any} e
 * @returns {string[]}
 */
export function entryProblems(e) {
  /** @type {string[]} */
  const p = [];
  const where = `catalog/${e?.id ?? '?'}`;
  if (!e || typeof e !== 'object') return [`${where}: not an object`];
  for (const f of ['id', 'name', 'description']) if (typeof e[f] !== 'string' || !e[f].trim()) p.push(`${where}: "${f}" is required`);
  if (typeof e.server?.package !== 'string' || !PIN_RE.test(String(e.server?.version))) p.push(`${where}: server must name a package and an exact version`);
  if (!Array.isArray(e.credentials) || e.credentials.length === 0) p.push(`${where}: at least one credential (decision 2: the gateway holds it)`);
  for (const c of e.credentials ?? []) {
    if (!ENV_RE.test(String(c.env)) || !c.title || !c.description) p.push(`${where}: each credential needs env (UPPER_CASE), title and description`);
    if (!(c.env in (e.probeEnv ?? {}))) p.push(`${where}: probeEnv must give a dummy ${c.env} so CI can list the tools`);
  }
  if (!e.reviewed?.by || !e.reviewed?.on) p.push(`${where}: "reviewed" must say by whom and when`);
  const actions = e.actions ?? {};
  for (const [name, t] of Object.entries(e.tools ?? {})) {
    const tool = /** @type {any} */ (t);
    if (typeof tool.summary !== 'string' || !tool.summary.trim()) p.push(`${where}.tools.${name}: needs a plain-language summary`);
    if (!tool.effect) p.push(`${where}.tools.${name}: needs a reviewed effect`);
    if (!(tool.action in actions)) p.push(`${where}.tools.${name}: action "${tool.action}" is not described in "actions"`);
  }
  if (p.length) return p;
  try {
    configFromCatalog([e], { agentConfig: './agent.metamynd.json', picks: [{ id: e.id, tools: Object.keys(e.tools) }] });
  } catch (err) {
    p.push(...(err instanceof ConfigError ? err.problems : [String(err)]));
  }
  return p;
}

/**
 * Load and validate every entry in a catalog directory.
 * @param {string} [dir]
 * @returns {Promise<Map<string, CatalogEntry>>}
 */
export async function loadCatalog(dir = CATALOG_DIR) {
  /** @type {Map<string, CatalogEntry>} */
  const entries = new Map();
  /** @type {string[]} */
  const problems = [];
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()) {
    const e = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
    if (`${e.id}.json` !== file) problems.push(`catalog/${file}: id "${e.id}" must match the file name`);
    problems.push(...entryProblems(e));
    entries.set(e.id, e);
  }
  if (problems.length) throw new ConfigError(problems);
  return entries;
}

/**
 * Build a gateway config (mcp-gateway.json) from the catalog tools an owner picked. Credentials are references only
 * (`${ENV}`, which the Claude Desktop extension turns into fields Claude stores securely; or `keychain:<id>-<env>`).
 * `actionMap` renames catalog actions to the agent's own mandate actions.
 * @param {Iterable<CatalogEntry>} catalog
 * @param {{ agentConfig: string, picks: Array<{ id: string, tools: string[] }>, actionMap?: Record<string, string>, credentials?: 'env' | 'keychain' }} opts
 * @returns {Record<string, any>} the config, already checked with parseConfig
 */
export function configFromCatalog(catalog, { agentConfig, picks, actionMap = {}, credentials = 'env' }) {
  const byId = new Map([...catalog].map((e) => [e.id, e]));
  /** @type {Record<string, any>} */
  const upstreams = {};
  /** @type {Record<string, any>} */
  const tools = {};
  /** @type {string[]} */
  const problems = [];
  for (const pick of picks) {
    const e = byId.get(pick.id);
    if (!e) { problems.push(`no catalog entry "${pick.id}"`); continue; }
    upstreams[e.id] = {
      command: 'npx',
      args: ['-y', `${e.server.package}@${e.server.version}`, ...(e.server.args ?? [])],
      env: Object.fromEntries(e.credentials.map((c) => [c.env, credentials === 'keychain' ? `keychain:${e.id}-${c.env.toLowerCase().replace(/_/g, '-')}` : `\${${c.env}}`])),
    };
    for (const name of pick.tools) {
      const t = e.tools[name];
      if (!t) { problems.push(`catalog/${e.id} has no tool "${name}"`); continue; }
      const { summary, ...mapping } = t;
      tools[`${e.id}.${name}`] = { ...mapping, action: actionMap[t.action] ?? t.action };
    }
  }
  if (problems.length) throw new ConfigError(problems);
  const config = { agentConfig, upstreams, tools };
  parseConfig(config, '/'); // the same checks the gateway makes at start
  return config;
}
