// Resolve the secret references in an upstream's env / headers (docs/design.md §4.1): `${VAR}` from the gateway's own
// environment, `keychain:<name>` from the OS keychain. A reference that cannot be resolved stops the gateway at start —
// an upstream started without its credential would fail on every call, or worse, fall back to something else.

/** @typedef {{ env?: Record<string, string | undefined>, keychain?: (name: string) => Promise<string | undefined> }} SecretSources */

export class SecretError extends Error {
  /** @param {string[]} missing */
  constructor(missing) {
    super(`cannot resolve ${missing.length} credential reference(s):\n${missing.map((m) => `  - ${m}`).join('\n')}`);
    this.name = 'SecretError';
    this.missing = missing;
  }
}

const VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
const KEYCHAIN_RE = /^keychain:([A-Za-z0-9._-]+)$/;

/**
 * Resolve every value of `values`. Problems are collected under `where` so the user sees them all at once.
 * @param {Record<string, string>} values
 * @param {string} where e.g. "upstreams.payments.env"
 * @param {SecretSources} sources
 * @param {string[]} missing collects unresolvable references
 * @returns {Promise<Record<string, string>>}
 */
export async function resolveSecrets(values, where, sources, missing) {
  const env = sources.env ?? process.env;
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    const kc = KEYCHAIN_RE.exec(value);
    if (kc) {
      const secret = sources.keychain ? await sources.keychain(kc[1]) : undefined;
      if (secret === undefined || secret === '') missing.push(`${where}.${key}: keychain item "${kc[1]}" not found${sources.keychain ? '' : ' (no keychain available)'}`);
      else out[key] = secret;
      continue;
    }
    out[key] = value.replace(VAR_RE, (_m, name) => {
      const v = env[name];
      if (v === undefined || v === '') {
        missing.push(`${where}.${key}: environment variable ${name} is not set`);
        return '';
      }
      return v;
    });
  }
  return out;
}
