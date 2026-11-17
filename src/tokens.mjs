// Access tokens for the remote (HTTP) gateway (docs/design.md §7, threat T9). One token per installation of an AI app
// (one Grok Bot connector, one team's client, …), so each can be revoked on its own.
//
// Only a SHA-256 hash of each token is stored, in the gateway's state directory; the token itself is shown once, when it
// is created. A token is 32 random bytes, so a plain hash is enough (no password stretching is needed for a value with
// 256 bits of entropy). The file is re-read whenever it changes, so a revocation takes effect on the next request without
// a restart.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const TOKEN_PREFIX = 'mmgw_';

/** @typedef {{ id: string, label: string, hash: string, createdAt: string, revokedAt?: string }} TokenEntry */

const hashOf = (/** @type {string} */ token) => createHash('sha256').update(token, 'utf8').digest();

/** @param {string} file */
async function readEntries(file) {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    return /** @type {TokenEntry[]} */ (Array.isArray(raw?.tokens) ? raw.tokens : []);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return [];
    throw err;
  }
}

/** @param {string} file @param {TokenEntry[]} tokens */
async function writeEntries(file, tokens) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ version: 1, tokens }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

/**
 * Run a read-modify-write of the token file under an exclusive lock file, so two `token` commands can't lose each
 * other's change (a revocation silently undone is the dangerous case). A lock older than 30 s is left over from a
 * crash, and is taken over.
 * @template T
 * @param {string} file
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withLock(file, fn) {
  await mkdir(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const h = await open(lock, 'wx', 0o600);
      await h.close();
      break;
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > 30_000) { await rm(lock, { force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`${lock} is held by another mcp-gateway command; try again, or delete it if none is running`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try { return await fn(); } finally { await rm(lock, { force: true }); }
}

/** The token file in a state directory. */
export const tokenFile = (/** @type {string} */ stateDir) => path.join(stateDir, 'http-tokens.json');

/**
 * Create a token. Returns the token itself (shown once, never stored) and its entry.
 * @param {string} file
 * @param {string} [label]
 */
export function createToken(file, label = '') {
  return withLock(file, async () => {
    const tokens = await readEntries(file);
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const entry = { id: randomBytes(6).toString('hex'), label: String(label).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 80), hash: hashOf(token).toString('hex'), createdAt: new Date().toISOString() };
    tokens.push(entry);
    await writeEntries(file, tokens);
    return { token, entry };
  });
}

/**
 * Revoke a token by id. Returns false if there is no such token.
 * @param {string} file
 * @param {string} id
 */
export function revokeToken(file, id) {
  return withLock(file, async () => {
    const tokens = await readEntries(file);
    const entry = tokens.find((t) => t.id === id);
    if (!entry) return false;
    entry.revokedAt ??= new Date().toISOString();
    await writeEntries(file, tokens);
    return true;
  });
}

/** @param {string} file */
export const listTokens = (file) => readEntries(file);

/**
 * A verifier for the HTTP server: `verify(presented)` resolves to the matching active entry, or null. It compares every
 * active hash in constant time, and re-reads the file when its modification time changes.
 * @param {string} file
 */
export function tokenVerifier(file) {
  /** @type {{ version: string, active: Array<{ entry: TokenEntry, hash: Buffer }> } | null} */
  let cache = null;
  async function active() {
    let version = 'absent';
    try { const s = await stat(file); version = `${s.mtimeMs}:${s.size}:${s.ino}`; } catch (err) { if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err; }
    if (!cache || cache.version !== version) {
      const entries = version === 'absent' ? [] : await readEntries(file);
      cache = { version, active: entries.filter((e) => !e.revokedAt && /^[0-9a-f]{64}$/.test(e.hash)).map((entry) => ({ entry, hash: Buffer.from(entry.hash, 'hex') })) };
    }
    return cache.active;
  }
  return {
    /** @param {string | undefined} presented */
    async verify(presented) {
      if (typeof presented !== 'string' || !presented.startsWith(TOKEN_PREFIX) || presented.length > 200) return null;
      const h = hashOf(presented);
      let match = null;
      for (const a of await active()) if (timingSafeEqual(a.hash, h)) match = a.entry; // no early exit
      return match;
    },
    /** How many tokens are active (for the startup log; never the tokens). */
    async count() { return (await active()).length; },
  };
}
