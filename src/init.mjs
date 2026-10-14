// `mcp-gateway init` (docs/design.md §4.2): connect to each upstream, read its tools, and draft a mapping for every tool
// not yet mapped (decision 4: every tool is governed). Each draft is marked `"review": true` and the gateway will not
// start until a person has checked it — the drafts are suggestions from names and the server's own annotations, which
// are never trusted at run time. Tools already mapped are left alone; one whose definition changed is reported with its
// new hash (the gateway withholds it until the mapping is updated).

import { schemaHashOf } from './schema-hash.mjs';
import { NAME_SEPARATOR, MAX_EXPOSED_NAME } from './config.mjs';

/** @typedef {import('./upstreams.mjs').ToolDef} ToolDef */

const AMOUNT_NAMES = ['amount', 'total', 'price', 'value', 'sum'];
const CURRENCY_NAMES = ['currency', 'currency_code', 'currencyCode'];
const MERCHANT_NAMES = ['payee', 'merchant', 'recipient', 'vendor', 'beneficiary', 'to'];

/** A mandate action key from a tool name: lower-case words joined by "-", e.g. createPayment → create-payment. */
export function actionFromToolName(/** @type {string} */ name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'tool';
}

/**
 * Draft one mapping from an upstream tool definition.
 * @param {ToolDef} def
 * @returns {Record<string, unknown>}
 */
export function draftMapping(def) {
  const props = def.inputSchema && typeof def.inputSchema === 'object' && def.inputSchema.properties && typeof def.inputSchema.properties === 'object'
    ? /** @type {Record<string, { type?: unknown }>} */ (def.inputSchema.properties) : {};
  const args = Object.keys(props);
  const find = (/** @type {string[]} */ names, /** @type {string | undefined} */ type) =>
    args.find((a) => names.includes(a) && (!type || props[a]?.type === type || (Array.isArray(props[a]?.type) && /** @type {unknown[]} */ (props[a].type).includes(type))));
  const amount = find(AMOUNT_NAMES, 'number') ?? find(AMOUNT_NAMES, 'integer');
  const currency = amount ? find(CURRENCY_NAMES, 'string') : undefined;
  const merchant = find(MERCHANT_NAMES, 'string');
  const ann = /** @type {{ readOnlyHint?: boolean, destructiveHint?: boolean }} */ (def.annotations ?? {});
  const riskLevel = amount || ann.destructiveHint ? 'high' : ann.readOnlyHint ? 'low' : 'medium';
  // The hint apps get, drafted from the server's own annotations and confirmed by the reviewer. A tool that moves value
  // is a write whatever the server claims; with no claim at all the draft is "destructive", MCP's own cautious default.
  const effect = amount ? 'write' : ann.destructiveHint === true ? 'destructive' : ann.readOnlyHint === true ? 'read' : 'destructive';
  return {
    review: true,
    action: actionFromToolName(def.name),
    ...(amount ? { amount } : {}),
    ...(currency ? { currency } : {}),
    ...(merchant ? { merchant } : {}),
    allowedArgs: args,
    effect,
    context: { riskLevel },
    schemaHash: schemaHashOf(def),
    ...(amount && !currency ? { _note: `"${amount}" looks like an amount but no currency argument was found; map one, or this tool cannot move value` } : {}),
  };
}

/**
 * Merge drafts for every unmapped tool into the raw config's `tools`.
 * @param {Record<string, unknown>} raw the config file's parsed JSON (modified copy returned)
 * @param {Map<string, ToolDef[]>} toolsByUpstream
 * @returns {{ config: Record<string, unknown>, drafted: string[], changed: Array<{ tool: string, schemaHash: string }>, missing: string[], tooLong: string[] }}
 */
export function draftTools(raw, toolsByUpstream) {
  const tools = /** @type {Record<string, Record<string, unknown>>} */ ({ ...(raw.tools && typeof raw.tools === 'object' ? raw.tools : {}) });
  /** @type {string[]} */ const drafted = [];
  /** @type {Array<{ tool: string, schemaHash: string }>} */ const changed = [];
  /** @type {string[]} */ const tooLong = [];
  const seen = new Set();
  for (const [upstream, defs] of toolsByUpstream) {
    for (const def of defs) {
      const key = `${upstream}.${def.name}`;
      seen.add(key);
      const existing = tools[key];
      if (existing) {
        const hash = schemaHashOf(def);
        if (existing.schemaHash !== hash) changed.push({ tool: key, schemaHash: hash });
        continue;
      }
      tools[key] = draftMapping(def);
      drafted.push(key);
      if (`${upstream}${NAME_SEPARATOR}${def.name}`.length > MAX_EXPOSED_NAME) tooLong.push(key);
    }
  }
  const missing = Object.keys(tools).filter((k) => toolsByUpstream.has(k.split('.')[0]) && !seen.has(k));
  return { config: { ...raw, tools }, drafted, changed, missing, tooLong };
}
