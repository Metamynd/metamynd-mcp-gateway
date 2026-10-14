// Build the release's base bundle and its checksum: node scripts/build-base.mjs <out-dir>
//   → <out-dir>/metamynd-mcp-gateway-<version>.mcpb and .mcpb.sha256 (`<hex>  <file>`, as sha256sum writes it)
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildBase } from '../src/extension.mjs';

const outDir = path.resolve(process.argv[2] ?? 'dist');
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
await mkdir(outDir, { recursive: true });
const name = `metamynd-mcp-gateway-${version}.mcpb`;
const file = path.join(outDir, name);
await buildBase({ outFile: file });
const sha = createHash('sha256').update(await readFile(file)).digest('hex');
await writeFile(`${file}.sha256`, `${sha}  ${name}\n`);
console.log(`${name}  sha256 ${sha}`);
