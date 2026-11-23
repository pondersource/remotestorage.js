import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverLWS } from '../build/lws-discovery.js';
import LWS from '../build/lws.js';
import LWSPathMap from '../build/lws-path-map.js';

const directory = process.env.LWS_CSS_SERVER_DIR;
const media = 'application/vnd.remotestorage.lws-index+json';

test('CSS-LWS discovers a public root issuer and rediscovers indexes with projected generic media types',
  { skip: !directory, timeout: 120000 }, async t => {
    const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const base = 'http://127.0.0.1:' + port + '/', root = base + 'rs-fixture/';
    const temporary = await mkdtemp(join(tmpdir(), 'rs-css-lws-'));
    const data = join(temporary, 'pods'), seed = join(temporary, 'seed.json');
    await writeFile(seed, JSON.stringify([{ email: 'fixture@example.test', password: crypto.randomUUID(), pods: [{ name: 'rs-fixture' }] }]));
    const child = spawn(process.execPath, [resolve(directory, 'bin/server.js'), '-c', 'config/solid-lws.json',
      '-f', data, '-b', base, '-p', String(port), '--seedConfig', seed], { cwd: resolve(directory), stdio: 'ignore' });
    t.after(async () => {
      if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
      await rm(temporary, { recursive: true, force: true });
    });
    let response;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) { throw new Error('CSS-LWS exited before the fixture was ready: ' + child.exitCode); }
      try { response = await fetch(root, { headers: { Accept: 'application/lws+cid' } }); if (response.ok) { break; } } catch { /* server booting */ }
      await delay(100);
    }
    assert.equal(response?.status, 200, 'the seeded CSS-LWS public root must be ready');
    assert.equal(response.headers.has('www-authenticate'), false);
    const found = await discoverLWS(root);
    assert.equal(found.storage, root);
    assert.deepEqual(found.authorizationServers, [base]);
    const events = [];
    const backend = new LWS({ remote: { connected: false }, local: {}, _emit: name => events.push(name), setBackend() {}, _fireReady() {} });
    backend.setStorageURL(root);
    await assert.rejects(backend.connect(), /requires sign-in/);
    assert.equal(backend.connected, false);
    assert.deepEqual(events, []);

    // This disposable public namespace exercises the native storage API/MIME
    // projection, not authentication. Private OIDC CRUD is the widget journey.
    await writeFile(join(data, 'rs-fixture', '.acl'), `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
<#fixture> a acl:Authorization; acl:agentClass foaf:Agent; acl:accessTo <./>; acl:default <./>; acl:mode acl:Read, acl:Write.
`);
    const send = (url, init) => fetch(url, { ...init, redirect: 'error', credentials: 'omit' });
    const a = new LWSPathMap(root, root, send);
    assert.equal((await a.create('/notes/a', 'first', 'text/plain')).status, 201);
    const first = await a.load();
    const listing = await (await send(root, { headers: { Accept: 'application/lws+json' } })).json();
    assert.equal(listing.items.find(item => item.id === first.url).format, 'application/octet-stream');
    assert.equal((await send(first.url, { method: 'HEAD' })).headers.get('content-type'), media);
    const b = new LWSPathMap(root, root, send);
    assert.equal((await b.load()).url, first.url);
    assert.equal(await (await send(b.lookup('/notes/a'))).text(), 'first');
    assert.equal((await b.create('/notes/b', 'second', 'text/plain')).status, 201);
    const after = await a.load();
    assert.equal(after.url, first.url);
    assert.equal(Object.keys(after.entries).length, 2);
    assert.equal(await (await send(after.entries['/notes/a'])).text(), 'first');
    assert.equal(await (await send(after.entries['/notes/b'])).text(), 'second');
  });
