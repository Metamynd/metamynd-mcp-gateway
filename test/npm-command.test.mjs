import { test } from 'node:test';
import assert from 'node:assert/strict';
import { npmCommand } from '../src/npm-command.mjs';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const NEXT_TO_NODE = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin';

test('macOS / Linux: npm and npx are run as they are, with the arguments as an array', () => {
  assert.deepEqual(npmCommand('npm', ['install', 'a b'], { platform: 'linux' }), { file: 'npm', args: ['install', 'a b'] });
  assert.deepEqual(npmCommand('npx', ['-y', 'x'], { platform: 'darwin' }), { file: 'npx', args: ['-y', 'x'] });
});

test('Windows: the npm CLI next to node.exe is run by Node itself, so no shell sees the arguments', () => {
  const exists = (/** @type {string} */ p) => p === `${NEXT_TO_NODE}\\npx-cli.js`;
  const hostile = 'out %PATH% & calc.mcpb';
  assert.deepEqual(npmCommand('npx', ['pack', '.', hostile], { platform: 'win32', execPath: NODE, npmExecPath: undefined, exists }), {
    file: NODE,
    args: [`${NEXT_TO_NODE}\\npx-cli.js`, 'pack', '.', hostile],
  });
});

test('Windows: under `npm run`, npm\'s own CLI directory comes first', () => {
  const npmBin = 'D:\\tools\\npm\\bin';
  const exists = () => true;
  assert.equal(npmCommand('npm', ['ci'], { platform: 'win32', execPath: NODE, npmExecPath: `${npmBin}\\npm-cli.js`, exists }).args[0], `${npmBin}\\npm-cli.js`);
  assert.equal(npmCommand('npx', ['x'], { platform: 'win32', execPath: NODE, npmExecPath: `${npmBin}\\npm-cli.js`, exists }).args[0], `${npmBin}\\npx-cli.js`);
});

test('Windows: with no npm CLI to be found it refuses rather than falling back to a shell', () => {
  assert.throws(() => npmCommand('npm', ['install'], { platform: 'win32', execPath: NODE, npmExecPath: undefined, exists: () => false }), /cannot find npm-cli\.js/);
});
