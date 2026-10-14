// The held-request journal (docs/design.md §3.3). When MetaMynd holds a call for a person, the gateway answers at once and
// remembers the escalation under the tool and the exact arguments. The same call made again later finds it and resumes
// the approval instead of asking afresh. Kept on disk so an approval survives the app being restarted; one file per
// agent, so approvals never cross agents.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from './schema-hash.mjs';

/** @typedef {{ escalationId: string, exposedName: string, heldAt: string }} HeldEntry */

/** The journal key for a call: the tool and a digest of its exact arguments. */
export function journalKey(/** @type {string} */ exposedName, /** @type {unknown} */ args) {
  const digest = createHash('sha256').update(canonicalJson(args ?? {}), 'utf8').digest('hex');
  return `${exposedName}|sha256:${digest}`;
}

/**
 * @param {string} file the journal file (in the gateway's state directory, per agent)
 */
export async function openJournal(file) {
  /** @type {Record<string, HeldEntry>} */
  let entries = {};
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') entries = raw.entries;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err;
  }
  let writing = Promise.resolve();
  const persist = () => {
    // Serialised, and written to a temporary file then renamed, so a crash never leaves a half-written journal.
    writing = writing.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, entries }, null, 2), { mode: 0o600 });
      await rename(tmp, file);
    });
    return writing;
  };
  return {
    /** @param {string} key */
    get: (key) => entries[key],
    /** @param {string} key @param {HeldEntry} entry */
    put: async (key, entry) => { entries[key] = entry; await persist(); },
    /** @param {string} key */
    delete: async (key) => { if (key in entries) { delete entries[key]; await persist(); } },
    size: () => Object.keys(entries).length,
  };
}

/** @typedef {Awaited<ReturnType<typeof openJournal>>} Journal */
