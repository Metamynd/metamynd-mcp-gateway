// Shared by catalog-draft and catalog-verify: install a catalog server's pinned package into a fresh, empty directory,
// start it over stdio with DUMMY credentials (listing tools must not need real ones), and return its tools.
// The package is third-party code: it runs in its own directory, with only PATH and the dummy credentials in its
// environment, and its install scripts are not run.

import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { listAllTools } from '../src/upstreams.mjs';

/**
 * @param {{ package: string, version: string, args?: string[] }} server
 * @param {Record<string, string>} dummyEnv
 * @returns {Promise<import('../src/upstreams.mjs').ToolDef[]>}
 */
export async function probeServer(server, dummyEnv) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mcpgw-catalog-'));
  try {
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'probe', private: true }));
    const spec = `${server.package}@${server.version}`;
    if (!/^(@[a-z0-9-]+\/)?[a-z0-9._-]+@[0-9A-Za-z.+-]+$/.test(spec)) throw new Error(`not a pinned package spec: ${spec}`);
    // npm is a .cmd script on Windows, which Node starts only through a shell: one fixed string there (the spec is
    // validated above), plain argument passing everywhere else.
    if (process.platform === 'win32') execSync(`npm install --no-audit --no-fund --ignore-scripts ${spec}`, { cwd: dir, stdio: 'ignore' });
    else execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', spec], { cwd: dir, stdio: 'ignore' });
    const pkgDir = path.join(dir, 'node_modules', ...server.package.split('/'));
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin ?? {})[0];
    if (!bin) throw new Error(`${server.package}@${server.version} has no bin entry to start`);
    const client = new Client({ name: 'mcpgw-catalog', version: '0' });
    const base = { PATH: process.env.PATH ?? '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(pkgDir, bin), ...(server.args ?? [])], env: { ...base, ...dummyEnv }, cwd: dir, stderr: 'ignore' }));
    try {
      return await listAllTools(/** @type {any} */ (client));
    } finally {
      await client.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
