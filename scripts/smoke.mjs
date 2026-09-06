import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const temp = mkdtempSync(join(tmpdir(), 'pi-plan-smoke-'));
const child = spawn(process.env.PI_BIN || 'pi', ['--mode', 'rpc', '--no-session', '--offline', '--no-approve',
  '--no-extensions', '-e', resolve('src/index.ts'), '-e', resolve('test/fixtures/runtime.ts'), '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files'], {
  cwd: temp,
  env: { PATH: process.env.PATH, HOME: temp, PI_CODING_AGENT_DIR: join(temp, 'agent'), PI_OFFLINE: '1', PI_TELEMETRY: '0', TERM: 'dumb' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let buffer = '', errors = '', id = 0;
const events = [], waiters = new Map();
child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => { errors += chunk; });
child.stdout.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { throw new Error(`Non-JSON RPC output: ${line}`); }
    events.push(event);
    const waiter = waiters.get(event.id);
    if (event.type === 'response' && waiter) { waiters.delete(event.id); waiter(event); }
  }
});
const request = (type, data = {}) => new Promise((resolveResponse, reject) => {
  const key = String(++id);
  const timer = setTimeout(() => reject(new Error(`RPC timeout ${type}: ${errors}`)), 15000);
  waiters.set(key, response => { clearTimeout(timer); resolveResponse(response); });
  child.stdin.write(JSON.stringify({ id: key, type, ...data }) + '\n');
});
try {
  let result = await request('get_commands');
  assert.equal(result.success, true); assert.ok(result.data.commands.some(command => command.name === 'plan'));
  await request('prompt', { message: '/plan-smoke-tools' });
  const initial = await request('get_entries');
  const originalTools = initial.data.entries.findLast(entry => entry.customType === 'plan-smoke-tools').data;
  result = await request('prompt', { message: '/plan' }); assert.equal(result.success, true);
  result = await request('get_entries');
  assert.equal(result.data.entries.findLast(entry => entry.customType === 'pi-plan-mode/v1').data.phase, 'planning');
  result = await request('bash', { command: 'printf should-not-run > forbidden.txt' });
  assert.equal(result.data.exitCode, 1); assert.match(result.data.output, /禁止 shell/);
  result = await request('prompt', { message: '/plan-smoke-reload' }); assert.equal(result.success, true);
  await request('prompt', { message: '/plan --exit' });
  await request('prompt', { message: '/plan-smoke-tools' });
  result = await request('get_entries');
  assert.deepEqual(result.data.entries.findLast(entry => entry.customType === 'plan-smoke-tools').data, originalTools);
  result = await request('get_entries'); assert.equal(result.data.entries.findLast(entry => entry.customType === 'pi-plan-mode/v1').data.phase, 'off');
  assert.ok(!events.some(event => event.type === 'agent_start' || event.type === 'extension_error'));
  console.log('PASS: Pi real CLI loader + RPC command/gate/state + real reload→exit exact tool restoration; zero agent_start or extension_error; isolated HOME, no credentials/network.');
} finally {
  child.stdin.end(); child.kill('SIGTERM');
  await new Promise(resolveExit => { if (child.exitCode !== null || child.signalCode !== null) resolveExit(); else child.once('exit', resolveExit); });
  rmSync(temp, { recursive: true, force: true });
}
