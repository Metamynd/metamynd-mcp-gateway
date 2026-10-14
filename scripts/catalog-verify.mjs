// Re-check every catalog entry against the real, pinned server: install it, list its tools with the dummy
// credentials, and compare each reviewed tool's schemaHash. Fails on any drift — a tool changed, vanished or added — so
// the catalog never offers a definition that is not the one MetaMynd reviewed. Run in CI on catalog changes and weekly.
//   node scripts/catalog-verify.mjs [id ...]
import { loadCatalog } from '../src/catalog.mjs';
import { schemaHashOf } from '../src/schema-hash.mjs';
import { probeServer } from './catalog-probe.mjs';

const only = process.argv.slice(2);
const catalog = await loadCatalog();
let failed = 0;
for (const entry of catalog.values()) {
  if (only.length && !only.includes(entry.id)) continue;
  const defs = await probeServer(entry.server, entry.probeEnv);
  const live = new Map(defs.map((d) => [d.name, schemaHashOf(d)]));
  /** @type {string[]} */
  const drift = [];
  for (const [name, t] of Object.entries(entry.tools)) {
    if (!live.has(name)) drift.push(`  - ${name}: no longer offered by ${entry.server.package}@${entry.server.version}`);
    else if (live.get(name) !== t.schemaHash) drift.push(`  ! ${name}: definition differs (live ${live.get(name)})`);
  }
  for (const name of live.keys()) if (!(name in entry.tools)) drift.push(`  + ${name}: offered but not reviewed`);
  if (drift.length) {
    failed++;
    console.log(`FAIL ${entry.id} (${entry.server.package}@${entry.server.version}):\n${drift.join('\n')}`);
  } else {
    console.log(`ok   ${entry.id}: ${live.size} tools match ${entry.server.package}@${entry.server.version}`);
  }
}
if (failed) process.exit(1);
