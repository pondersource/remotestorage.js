// Starts the pinned independent LWS implementation checked out by the workflow.
// Anonymous writes are bound to loopback and stored in a disposable directory.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const checkout = resolve(process.env.LWSD_CHECKOUT || '.lwsd');
const data = await mkdtemp(join(tmpdir(), 'rs-lwsd-interop-'));
const port = process.env.LWSD_PORT || '3126';
const url = 'http://127.0.0.1:' + port + '/lws/';
const server = spawn(process.execPath, [join(checkout, 'index.js'), '--no-auth', '--host', '127.0.0.1', '--port', port, '--root', data], { stdio: 'inherit' });
let spawnError;
server.on('error', error => { spawnError = error; });
async function run(args) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, LWS_REAL_SERVER_URL: url } });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  if (code !== 0) throw new Error('LWS interoperability checks failed (exit ' + code + ').');
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (spawnError) throw spawnError;
    if (server.exitCode !== null) throw new Error('LWSD exited before becoming ready.');
    try { const response = await fetch(url, { headers: { Accept: 'application/lws+cid' }, signal: AbortSignal.timeout(1000) }); ready = response.ok; } catch { /* starting */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('LWSD did not become ready.');
  await run(['--test', 'test/lws-interop.test.mjs']);
  await run(['node_modules/@playwright/test/cli.js', 'test', '--config=playwright.lws.config.cjs']);
} finally {
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolve => { server.once('exit', resolve); setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 5000).unref(); });
  }
  await rm(data, { recursive: true, force: true });
}
