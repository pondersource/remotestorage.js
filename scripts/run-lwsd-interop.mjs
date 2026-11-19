// Starts the pinned independent LWS implementation checked out by the workflow.
// Anonymous writes are bound to loopback and stored in a disposable directory.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const java = process.env.LWS_SERVER_KIND === 'ebremer';
const checkout = resolve(process.env.LWS_SERVER_CHECKOUT || process.env.LWSD_CHECKOUT || (java ? '.lws-server' : '.lwsd'));
const data = await mkdtemp(join(tmpdir(), 'rs-lwsd-interop-'));
const port = process.env.LWSD_PORT || (java ? '3127' : '3126');
const url = 'http://127.0.0.1:' + port + (java ? '/' : '/lws/');
const server = java
  ? spawn('java', ['-Dlws.base-uri=' + url, '-Dlws.listen-port=' + port, '-Dlws.dev.open=true', '-Dlws.public-read=true', '-Dlws.data-dir=' + data,
    '-Dlws.cors.allowed-origins=http://127.0.0.1:42123', '-jar', join(checkout, 'target/lws-server.jar')], { stdio: 'inherit' })
  : spawn(process.execPath, [join(checkout, 'index.js'), '--no-auth', '--host', '127.0.0.1', '--port', port, '--root', data], { stdio: 'inherit' });
let spawnError;
server.on('error', error => { spawnError = error; });
async function run(args) {
  const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env, LWS_REAL_SERVER_URL: url, LWS_APP_PORT: '42123' } });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  if (code !== 0) throw new Error('LWS interoperability checks failed (exit ' + code + ').');
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 300; attempt++) {
    if (spawnError) throw spawnError;
    if (server.exitCode !== null) throw new Error('LWSD exited before becoming ready.');
    try { const response = await fetch(url, { headers: { Accept: 'application/lws+cid' }, signal: AbortSignal.timeout(1000) }); ready = response.ok; } catch { /* starting */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!ready) throw new Error('LWSD did not become ready.');
  const failures = [];
  try { await run(['--test', 'test/lws-interop.test.mjs']); } catch (error) { failures.push(error); }
  try { await run(['node_modules/@playwright/test/cli.js', 'test', '--config=playwright.lws.config.cjs']); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'Real LWS server interoperability failed.');
} finally {
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(resolve => { server.once('exit', resolve); setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 5000).unref(); });
  }
  await rm(data, { recursive: true, force: true });
}
