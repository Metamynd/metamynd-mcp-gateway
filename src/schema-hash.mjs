// The pin for a reviewed tool definition (docs/design.md §6, T4): a sha256 over the canonical JSON of what the model is
// shown and what the tool accepts — its name, description and input schema. If an upstream renames a tool, changes its
// arguments or rewrites its description, the hash changes and the tool is withheld until someone reviews it again.

import { createHash } from 'node:crypto';

/**
 * JSON with object keys sorted at every level, so the same definition always hashes the same.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const obj = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/**
 * @param {{ name: string, description?: string, inputSchema?: unknown }} tool an entry of an upstream's tools/list
 * @returns {string} `sha256:<64 hex>`
 */
export function schemaHashOf(tool) {
  const pinned = { name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? {} };
  return `sha256:${createHash('sha256').update(canonicalJson(pinned), 'utf8').digest('hex')}`;
}
