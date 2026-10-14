// `keychain:<name>` credentials (docs/design.md §4.1): the operating system's own secret store, so an upstream's key never
// sits in a file the AI app — or a tool it can use — could read.
//   - macOS: the login Keychain (`security`), service "metamynd-mcp-gateway", account <name>.
//   - Linux: the desktop keyring through libsecret (`secret-tool`), attributes service + account.
//   - Windows: DPAPI, scoped to the user, through PowerShell (no native addon), one protected blob per secret in the
//     gateway's state directory — the same mechanism the AgentSafe signer uses for its key-encryption key.
// A secret always travels over stdin, never on a command line, where other processes could read it.

import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SERVICE = 'metamynd-mcp-gateway';
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * @typedef {(cmd: string, args: string[], input?: string) => Promise<{ code: number, stdout: string, stderr: string }>} Runner
 */

/** @type {Runner} */
const runProcess = (cmd, args, input) => new Promise((resolve) => {
  const child = execFile(cmd, args, { windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
    const code = err ? (typeof (/** @type {any} */ (err).code) === 'number' ? /** @type {any} */ (err).code : 1) : 0;
    resolve({ code, stdout: String(stdout), stderr: String(stderr) });
  });
  child.stdin?.end(input ?? '');
});

const DPAPI_PROTECT = "Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd().Trim(); $b=[Convert]::FromBase64String($in); $p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); [Console]::Out.Write([Convert]::ToBase64String($p))";
const DPAPI_UNPROTECT = "Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd().Trim(); $b=[Convert]::FromBase64String($in); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); [Console]::Out.Write([Convert]::ToBase64String($p))";

/** @param {string} name */
function checkName(name) {
  if (!NAME_RE.test(name)) throw new Error(`a keychain name is 1-64 letters, digits, ".", "_" or "-" (got "${name}")`);
}

/**
 * @param {{ stateDir: string, platform?: NodeJS.Platform, run?: Runner }} opts
 */
export function createKeychain({ stateDir, platform = process.platform, run = runProcess }) {
  const blobPath = (/** @type {string} */ name) => path.join(stateDir, 'secrets', `${name}.dpapi`);

  /**
   * @param {string} name
   * @returns {Promise<string | undefined>} the secret, or undefined when there is none
   */
  async function get(name) {
    checkName(name);
    if (platform === 'darwin') {
      const r = await run('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
      return r.code === 0 ? r.stdout.replace(/\n$/, '') : undefined;
    }
    if (platform === 'win32') {
      let blob;
      try { blob = (await readFile(blobPath(name), 'utf8')).trim(); } catch { return undefined; }
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_UNPROTECT], blob);
      if (r.code !== 0) throw new Error(`could not unprotect keychain item "${name}" (it may belong to another Windows user)`);
      return Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
    }
    const r = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', name]);
    return r.code === 0 && r.stdout ? r.stdout.replace(/\n$/, '') : undefined;
  }

  /**
   * @param {string} name
   * @param {string} value
   */
  async function set(name, value) {
    checkName(name);
    if (!value) throw new Error('a secret cannot be empty');
    if (platform === 'darwin') {
      // `security -i` reads its commands from stdin; -X takes the password as hex, so no quoting can break it and it
      // never appears in a process listing.
      const hex = Buffer.from(value, 'utf8').toString('hex');
      const r = await run('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${name} -X ${hex}\n`);
      if (r.code !== 0) throw new Error(`could not store "${name}" in the Keychain: ${r.stderr.trim()}`);
      return;
    }
    if (platform === 'win32') {
      const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_PROTECT], Buffer.from(value, 'utf8').toString('base64'));
      if (r.code !== 0) throw new Error(`could not protect "${name}" with DPAPI: ${r.stderr.trim()}`);
      await mkdir(path.dirname(blobPath(name)), { recursive: true });
      const tmp = `${blobPath(name)}.${process.pid}.tmp`;
      await writeFile(tmp, r.stdout.trim(), { mode: 0o600 });
      await rename(tmp, blobPath(name));
      return;
    }
    const r = await run('secret-tool', ['store', `--label=MetaMynd MCP gateway: ${name}`, 'service', SERVICE, 'account', name], value);
    if (r.code !== 0) throw new Error(`could not store "${name}" with secret-tool (is a desktop keyring running?): ${r.stderr.trim()}`);
  }

  return { get, set };
}
