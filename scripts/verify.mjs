import { existsSync, mkdirSync, realpathSync, symlinkSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// Only create local resolution links to existing packages. Never npm install/npx.
const executable = process.env.PI_BIN || execFileSync('which', ['pi'], { encoding: 'utf8' }).trim();
let root = process.env.PI_ROOT || dirname(realpathSync(executable));
if (!process.env.PI_ROOT) while (!existsSync(join(root, 'package.json')) && dirname(root) !== root) root = dirname(root);
if (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name !== '@earendil-works/pi-coding-agent') throw new Error('PI_ROOT must point to the installed Pi package');
const links = {
  '@earendil-works/pi-coding-agent': root,
  '@earendil-works/pi-tui': join(root, 'node_modules/@earendil-works/pi-tui'),
  'typebox': join(root, 'node_modules/typebox'),
  '@types/node': join(root, 'node_modules/@types/node'),
};
for (const [name, target] of Object.entries(links)) {
  const dest = resolve('node_modules', name);
  if (!existsSync(target)) throw new Error(`Missing installed dependency: ${target}`);
  mkdirSync(dirname(dest), { recursive: true });
  if (!existsSync(dest)) symlinkSync(target, dest, 'dir');
  else if (realpathSync(dest) !== realpathSync(target)) throw new Error(`Refusing to overwrite ${dest}`);
}
const task = process.argv[2];
let command = process.execPath;
let args;
if (task === 'test') args = ['--experimental-transform-types', '--test', 'test/core.test.ts', 'test/ui.test.ts'];
else if (task === 'smoke') args = ['scripts/smoke.mjs'];
else if (task === 'typecheck') { command = process.env.TSC || 'tsc'; args = ['--noEmit', '-p', 'tsconfig.json']; }
else throw new Error('Use test | typecheck | smoke');
const result = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, PI_ROOT: root, PI_BIN: executable } });
if (result.error) { console.error(result.error.message); process.exit(1); }
process.exit(result.status ?? 1);
