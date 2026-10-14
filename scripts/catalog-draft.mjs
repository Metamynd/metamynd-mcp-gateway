// Draft a catalog entry for a pinned MCP server: node scripts/catalog-draft.mjs <id> <package> <version> <ENV=dummy>...
// Prints JSON to review by hand — every effect, action and summary is a person's judgment, not the server's claim.
import { draftMapping } from '../src/init.mjs';
import { probeServer } from './catalog-probe.mjs';

const [id, pkg, version, ...envPairs] = process.argv.slice(2);
if (!id || !pkg || !version) {
  console.error('usage: node scripts/catalog-draft.mjs <id> <package> <version> [ENV=dummy ...]');
  process.exit(2);
}
const probeEnv = Object.fromEntries(envPairs.map((p) => p.split('=')));
const tools = await probeServer({ package: pkg, version }, probeEnv);
/** @type {Record<string, unknown>} */
const drafted = {};
for (const def of tools) {
  const { review, _note, ...m } = /** @type {Record<string, unknown>} */ (draftMapping(def));
  drafted[def.name] = { summary: String((def.annotations && /** @type {any} */ (def.annotations).title) || def.name), ...m };
}
console.log(JSON.stringify({
  id,
  name: id,
  description: '',
  server: { package: pkg, version },
  credentials: Object.keys(probeEnv).map((env) => ({ env, title: env, description: '' })),
  probeEnv,
  tools: drafted,
}, null, 2));
