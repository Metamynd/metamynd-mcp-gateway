// Run npm / npx with an argument array and never through a shell.
// On Windows `npm` and `npx` are .cmd scripts, which Node starts only through cmd.exe, and cmd.exe expands `%VAR%` even
// inside quotes. So there the JavaScript CLI that the .cmd script would have run is started directly with this Node.

import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The file and arguments to hand `execFile` / `execFileSync` for `npm` or `npx`.
 * @param {'npm' | 'npx'} tool
 * @param {string[]} args
 * @param {{ platform?: string, execPath?: string, npmExecPath?: string, exists?: (p: string) => boolean }} [env] for tests
 * @returns {{ file: string, args: string[] }}
 */
export function npmCommand(tool, args, { platform = process.platform, execPath = process.execPath, npmExecPath = process.env.npm_execpath, exists = existsSync } = {}) {
  if (platform !== 'win32') return { file: tool, args };
  const cli = `${tool}-cli.js`;
  const candidates = [
    // Set by npm itself when this runs under `npm run`/`npx`; it points at npm-cli.js (or npx-cli.js) in npm's bin/.
    ...(npmExecPath && /-cli\.js$/.test(npmExecPath) ? [path.win32.join(path.win32.dirname(npmExecPath), cli)] : []),
    // Every Windows Node install (the official installer, nvm-windows, Volta, Scoop) keeps npm next to node.exe.
    path.win32.join(path.win32.dirname(execPath), 'node_modules', 'npm', 'bin', cli),
  ];
  const found = candidates.find((p) => exists(p));
  if (!found) throw new Error(`cannot find ${cli} next to ${execPath}; install Node.js with npm, or run this through npm`);
  return { file: execPath, args: [found, ...args] };
}
