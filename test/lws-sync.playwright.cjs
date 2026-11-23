const { test, expect } = require('@playwright/test');
const http = require('node:http');
const { readFileSync } = require('node:fs');
const { resolve, basename } = require('node:path');
const { createServer } = require('./lws-server.cjs');
let storage, app, address;
const external = process.env.LWS_REAL_SERVER_URL;
test.beforeAll(async () => {
  storage = external ? { close: async () => {} } : await createServer();
  app = http.createServer((req, res) => {
    if (req.url.endsWith('.js')) {
      try { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(readFileSync(resolve(__dirname, '../release', basename(req.url)))); }
      catch { res.end(''); }
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<!doctype html><html><body><p>rs.js LWS sync fixture</p><script src="/remotestorage-all.js"></script><script>
      window.ready = false; window.errors = []; window.events = []; window.conflicts = [];
      window.rs = new RemoteStorage({ disableFeatures: ['Solid', 'Dropbox', 'GoogleDrive'] });
      rs.access.claim('notes', 'rw'); rs.caching.enable('/notes/');
      window.notes = rs.scope('/notes/');
      rs.on('error', error => window.errors.push(error.message));
      notes.on('change', change => { if (change.origin === 'conflict') window.conflicts.push(change); });
      for (const event of ['sync-started', 'sync-req-done', 'sync-done', 'network-offline', 'network-online']) {
        rs.on(event, data => {
          window.events.push({ event, data, at: performance.now() });
          if (window.events.length > 200) window.events.shift();
        });
      }
      rs.on('ready', () => { window.ready = true; });
      window.connectStorage = async () => { rs.lws.setStorageURL(${JSON.stringify(external || storage.base + '/storage')}); await rs.lws.connect(); };
    </script></body></html>`);
  });
  await new Promise(resolve => app.listen(Number(process.env.LWS_APP_PORT || 0), '127.0.0.1', resolve));
  address = 'http://127.0.0.1:' + app.address().port;
});
test.afterAll(async () => { await storage.close(); await new Promise(resolve => app.close(resolve)); });
test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const diagnostics = await page.evaluate(async () => ({
    errors: window.errors, events: window.events, conflicts: window.conflicts, requests: window.requests,
    sync: rs.sync && { stopped: rs.sync.stopped, done: rs.sync.done, tasks: Object.keys(rs.sync._tasks), running: Object.keys(rs.sync._running) },
    online: rs.remote.online,
    nodes: await rs.local.getNodes(['/', '/notes/', '/notes/a.txt', '/notes/uncertain.txt'])
  })).catch(error => ({ diagnosticsError: error.message }));
  console.log('LWS browser failure diagnostics: ' + JSON.stringify(diagnostics));
  await info.attach('lws-browser-diagnostics', { body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json' });
});
async function connect(page) {
  const messages = []; page.on('pageerror', error => messages.push(error.message));
  await page.goto(address);
  try { await page.waitForFunction(() => window.ready === true); }
  catch (error) { throw new Error(error.message + '\nBrowser errors: ' + messages.join('\n')); }
  await page.evaluate(() => window.connectStorage());
}
const fileBodies = async (path = '/notes/a.txt') => {
  const rootURL = external || storage.base + '/root';
  const response = await fetch(rootURL, { headers: { Accept: 'application/lws+json' } });
  const root = await response.json();
  const index = root.items.find(item => item.format?.split(';')[0] === 'application/vnd.remotestorage.lws-index+json');
  if (!index) return [];
  const map = await (await fetch(new URL(index.id, rootURL))).json();
  const url = map.entries[path];
  if (!url) return [];
  const file = await fetch(url);
  return file.status === 404 ? [] : [await file.text()];
};
async function replacePhysicalFile(path, body) {
  const rootURL = external || storage.base + '/root';
  const root = await (await fetch(rootURL, { headers: { Accept: 'application/lws+json' } })).json();
  const index = root.items.find(item => item.format?.split(';')[0] === 'application/vnd.remotestorage.lws-index+json');
  const map = await (await fetch(new URL(index.id, rootURL))).json();
  const url = map.entries[path], head = await fetch(url, { method: 'HEAD' });
  const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/plain', 'If-Match': head.headers.get('etag') }, body });
  expect([200, 204]).toContain(response.status);
}
async function acknowledged(page, path, body) {
  // Server visibility can precede the client's acknowledgement, particularly
  // while a newly created opaque resource is being committed to the index.
  await expect.poll(() => page.evaluate(async ({ path, body }) => {
    const node = (await rs.local.getNodes([path]))[path];
    return node?.common?.body === body && !!node.common.revision && !node.local && !node.push;
  }, { path, body }), { timeout: 20000 }).toBe(true);
}

test('the real rs.js cache syncs offline edits and a new browser pulls them from opaque LWS URLs', async ({ page, context, browser }) => {
  await connect(page);
  await page.evaluate(() => notes.storeFile('text/plain', 'a.txt', 'first revision'));
  await expect.poll(fileBodies, { timeout: 20000 }).toEqual(['first revision']);
  await acknowledged(page, '/notes/a.txt', 'first revision');

  await page.evaluate(() => rs.stopSync());
  await context.setOffline(true);
  await page.evaluate(() => notes.storeFile('text/plain', 'a.txt', 'edited while offline'));
  expect(await page.evaluate(async () => (await notes.getFile('a.txt', false)).data)).toBe('edited while offline');
  expect(await fileBodies()).toEqual(['first revision']);
  await context.setOffline(false);
  await page.evaluate(() => rs.startSync());
  await expect.poll(fileBodies, { timeout: 20000 }).toEqual(['edited while offline']);

  const freshContext = await browser.newContext();
  try {
    const freshPage = await freshContext.newPage(); await connect(freshPage);
    await expect.poll(() => freshPage.evaluate(async () => (await notes.getFile('a.txt'))?.data), { timeout: 20000 }).toBe('edited while offline');
  } finally { await freshContext.close(); }

  await page.reload(); await page.waitForFunction(() => window.ready === true);
  await page.evaluate(() => window.connectStorage());
  expect(await page.evaluate(async () => (await notes.getFile('a.txt')).data)).toBe('edited while offline');
  await page.evaluate(() => notes.remove('a.txt'));
  await expect.poll(async () => (await fileBodies()).length, { timeout: 20000 }).toBe(0);
});

test('a lost creation acknowledgement exposes both conflict candidates without retrying create forever', async ({ page, context }) => {
  await connect(page);
  await page.evaluate(() => {
    const request = rs.lws.request;
    let held = false;
    window.creationCommitted = false;
    window.requests = [];
    window.putAttempts = 0; window.getAttempts = 0;
    const put = rs.lws.put.bind(rs.lws), get = rs.lws.get.bind(rs.lws);
    rs.lws.put = (...args) => { if (args[0] === '/notes/uncertain.txt') window.putAttempts++; return put(...args); };
    rs.lws.get = (...args) => { if (args[0] === '/notes/uncertain.txt') window.getAttempts++; return get(...args); };
    rs.lws.request = async (url, init) => {
      const response = await request(url, init);
      window.requests.push({ method: init?.method || 'GET', url, status: response.status, ifMatch: new Headers(init?.headers).get('If-Match'), revision: response.headers.get('etag') });
      if (window.requests.length > 50) window.requests.shift();
      if (!held && response.ok && init?.method === 'PUT' &&
          new Headers(init.headers).get('Content-Type')?.startsWith('application/vnd.remotestorage.lws-index+json') &&
          init.body.includes('/notes/uncertain.txt')) {
        held = true;
        window.creationCommitted = true;
        await new Promise(resolve => { window.interruptAcknowledgement = resolve; });
        throw new TypeError('Simulated lost response after the index commit');
      }
      return response;
    };
  });
  await page.evaluate(() => notes.storeFile('text/plain', 'uncertain.txt', 'first revision'));
  await page.waitForFunction(() => window.creationCommitted);
  expect(await fileBodies('/notes/uncertain.txt')).toEqual(['first revision']);

  await page.evaluate(() => rs.stopSync());
  await context.setOffline(true);
  await page.evaluate(() => notes.storeFile('text/plain', 'uncertain.txt', 'edited while offline'));
  // Make this a genuine conflict, rather than the now-provable acknowledgement
  // of the exact immutable candidate that this client already sent.
  await replacePhysicalFile('/notes/uncertain.txt', 'foreign revision');
  await page.evaluate(() => window.interruptAcknowledgement());
  await page.waitForFunction(() => window.errors.length > 0 && !Object.keys(rs.sync._running).length);
  expect(await page.evaluate(async () => (await notes.getFile('uncertain.txt', false)).data)).toBe('edited while offline');

  await context.setOffline(false);
  await page.evaluate(() => rs.startSync());
  await expect.poll(() => page.evaluate(() => window.conflicts.length)).toBe(1);
  const conflict = await page.evaluate(() => window.conflicts[0]);
  expect(conflict.oldValue).toBe('edited while offline');
  expect(conflict.newValue).toBe('foreign revision');
  expect(conflict.lastCommonValue).toBeUndefined();
  expect(await page.evaluate(() => ({ puts: window.putAttempts, gets: window.getAttempts }))).toEqual({ puts: 1, gets: 1 });
  expect(await fileBodies('/notes/uncertain.txt')).toEqual(['foreign revision']);

  // rs.js exposes the two versions; only an explicit application decision
  // writes its chosen candidate back with the reviewed remote validator.
  await page.evaluate(async () => {
    const node = (await rs.sync.listInterruptedWrites()).find(node => node.path === '/notes/uncertain.txt');
    await rs.sync.resolveInterruptedWrite(node.path, node.push.operation.id, 'local');
  });
  await expect.poll(() => fileBodies('/notes/uncertain.txt'), { timeout: 20000 }).toEqual(['edited while offline']);
  await acknowledged(page, '/notes/uncertain.txt', 'edited while offline');
  await page.evaluate(() => notes.remove('uncertain.txt'));
  await expect.poll(() => fileBodies('/notes/uncertain.txt'), { timeout: 20000 }).toEqual([]);
});

test('JSON edits survive revalidation after an acknowledgement without an ETag', async ({ page, browser }) => {
  await connect(page);
  await page.evaluate(() => {
    notes.declareType('note', { type: 'object', properties: { title: { type: 'string' } } });
    const request = rs.lws.request;
    rs.lws.request = async (url, init) => {
      const response = await request(url, init);
      if (!['POST', 'PUT'].includes(init?.method) || !response.ok) return response;
      const headers = new Headers(response.headers); headers.delete('etag');
      const body = [204, 205].includes(response.status) ? null : await response.arrayBuffer();
      return new Response(body, { status: response.status, headers });
    };
    return notes.storeObject('note', 'etagless.json', { title: 'first' });
  });
  await expect.poll(() => page.evaluate(async () => {
    const node = (await rs.local.getNodes(['/notes/etagless.json']))['/notes/etagless.json'];
    return node?.common?.body && JSON.parse(node.common.body).title === 'first' && !node.local && !node.push;
  }), { timeout: 20000 }).toBe(true);
  await page.evaluate(async () => {
    rs.stopSync();
    await notes.storeObject('note', 'etagless.json', { title: 'second' });
    rs.startSync();
  });
  await expect.poll(async () => {
    const bodies = await fileBodies('/notes/etagless.json');
    return bodies.length ? JSON.parse(bodies[0]).title : undefined;
  }, { timeout: 20000 }).toBe('second');
  expect(await page.evaluate(() => window.conflicts)).toEqual([]);
  expect(await page.evaluate(async () => (await notes.getObject('etagless.json')).title)).toBe('second');
  const fresh = await browser.newContext();
  try {
    const next = await fresh.newPage(); await connect(next);
    await expect.poll(() => next.evaluate(async () => (await notes.getObject('etagless.json'))?.title), { timeout: 20000 }).toBe('second');
  } finally { await fresh.close(); }
  await page.evaluate(() => notes.remove('etagless.json'));
  await expect.poll(() => fileBodies('/notes/etagless.json'), { timeout: 20000 }).toEqual([]);
});

async function holdCommittedEdit(page, path, body) {
  await page.evaluate(async ({ path, body }) => {
    const url = rs.lws.getFileURL(path), request = rs.lws.request;
    window.committedEdit = false;
    rs.lws.request = async (target, init) => {
      const response = await request(target, init);
      if (target === url && init?.method === 'PUT' && response.ok) {
        window.committedEdit = true;
        await new Promise(resolve => { window.releaseEdit = resolve; });
      }
      return response;
    };
    await notes.storeFile('text/plain', path.slice('/notes/'.length), body);
  }, { path, body });
  await page.waitForFunction(() => window.committedEdit);
  await expect.poll(() => page.evaluate(async ({ path }) => {
    const node = (await rs.local.getNodesFromDb([path]))[path];
    return node?.push?.body;
  }, { path })).toBe(body);
}

test('a reload confirms an already committed push without resending it or losing its IndexedDB candidate', async ({ page, context }) => {
  const path = '/notes/reload.txt';
  await connect(page);
  await page.evaluate(() => notes.storeFile('text/plain', 'reload.txt', 'base'));
  await acknowledged(page, path, 'base');
  const url = await page.evaluate(path => rs.lws.getFileURL(path), path);
  const mutations = [];
  context.on('request', request => { if (request.url() === url && request.method() === 'PUT') mutations.push(request); });
  await holdCommittedEdit(page, path, 'committed before reload');
  expect(mutations).toHaveLength(1);
  await page.reload(); await page.waitForFunction(() => window.ready === true);
  await page.evaluate(() => window.connectStorage());
  await expect.poll(() => page.evaluate(async path => {
    const node = (await rs.local.getNodesFromDb([path]))[path];
    return node?.common?.body === 'committed before reload' && !node.local && !node.push;
  }, path), { timeout: 10000 }).toBe(true);
  expect(mutations).toHaveLength(1);
  expect(await page.evaluate(() => window.conflicts)).toEqual([]);
  expect(await page.evaluate(async () => (await notes.getFile('reload.txt', false)).data)).toBe('committed before reload');
  await page.evaluate(() => notes.remove('reload.txt'));
  await expect.poll(() => fileBodies(path)).toEqual([]);
});

test('another live tab cannot steal a pending IndexedDB push or acknowledge it with a replacement snapshot', async ({ page, context }) => {
  const path = '/notes/live-owner.txt';
  await connect(page);
  await page.evaluate(() => notes.storeFile('text/plain', 'live-owner.txt', 'base'));
  await acknowledged(page, path, 'base');
  const url = await page.evaluate(path => rs.lws.getFileURL(path), path);
  const mutations = [];
  context.on('request', request => { if (request.url() === url && request.method() === 'PUT') mutations.push(request); });
  await holdCommittedEdit(page, path, 'live owner candidate');
  const other = await context.newPage();
  try {
    await connect(other);
    await other.evaluate(() => { window.readStarted = true; window.pendingRead = notes.getFile('live-owner.txt', 0); });
    await expect.poll(() => other.evaluate(async () => {
      const locks = await navigator.locks.query();
      return locks.held.some(lock => lock.name.includes('live-owner.txt')) && locks.pending.some(lock => lock.name.includes('live-owner.txt'));
    }), { timeout: 3000 }).toBe(true);
    expect(mutations).toHaveLength(1);
    expect(await other.evaluate(async path => (await rs.local.getNodesFromDb([path]))[path].push.body, path)).toBe('live owner candidate');
    await page.evaluate(() => window.releaseEdit());
    await acknowledged(page, path, 'live owner candidate');
    expect(await other.evaluate(async () => (await window.pendingRead).data)).toBe('live owner candidate');
    expect(await other.evaluate(() => window.conflicts)).toEqual([]);
  } finally { await other.close(); }
  await page.evaluate(() => notes.remove('live-owner.txt'));
  await expect.poll(() => fileBodies(path)).toEqual([]);
});

async function holdUnsentEdit(page, path, body) {
  await page.evaluate(async ({ path, body }) => {
    const url = rs.lws.getFileURL(path), request = rs.lws.request;
    window.unsentEdit = false;
    rs.lws.request = async (target, init) => {
      if (target === url && init?.method === 'PUT') {
        window.unsentEdit = true;
        await new Promise(() => {});
      }
      return request(target, init);
    };
    await notes.storeFile('text/plain', path.slice('/notes/'.length), body);
  }, { path, body });
  await page.waitForFunction(() => window.unsentEdit);
}

test('a dead owner reads the unchanged base before conditionally sending the newest local edit', async ({ page, context }) => {
  const path = '/notes/not-sent.txt'; await connect(page);
  await page.evaluate(() => notes.storeFile('text/plain', 'not-sent.txt', 'base'));
  await acknowledged(page, path, 'base');
  const before = await page.evaluate(async path => ({ url: rs.lws.getFileURL(path), revision: (await rs.local.getNodes([path]))[path].common.revision }), path);
  const requests = [];
  context.on('request', request => { if (request.url() === before.url && ['GET', 'PUT'].includes(request.method())) requests.push(request); });
  await holdUnsentEdit(page, path, 'first unsent edit');
  // A local edit must not wait for the held network operation or replace its snapshot.
  await page.evaluate(() => notes.storeFile('text/plain', 'not-sent.txt', 'newest edit'));
  expect(await page.evaluate(async path => (await rs.local.getNodesFromDb([path]))[path].push.body, path)).toBe('first unsent edit');
  await page.reload(); await page.waitForFunction(() => window.ready === true);
  await page.evaluate(() => window.connectStorage());
  await acknowledged(page, path, 'newest edit');
  expect(requests[0].method()).toBe('GET');
  const puts = requests.filter(request => request.method() === 'PUT');
  expect(puts).toHaveLength(1);
  expect(puts[0].headers()['if-match']).toBe('"' + before.revision + '"');
  expect(puts[0].postData()).toBe('newest edit');
  expect(await page.evaluate(() => window.conflicts)).toEqual([]);
  await page.evaluate(() => notes.remove('not-sent.txt'));
  await expect.poll(() => fileBodies(path)).toEqual([]);
});

for (const foreign of ['', 'foreign writer']) test('differing readback stays a durable reviewed conflict after reload: ' + JSON.stringify(foreign), async ({ page, context }) => {
  const path = '/notes/review.txt'; await connect(page);
  await page.evaluate(() => notes.storeFile('text/plain', 'review.txt', 'base'));
  await acknowledged(page, path, 'base');
  const url = await page.evaluate(path => rs.lws.getFileURL(path), path);
  const mutations = [];
  context.on('request', request => { if (request.url() === url && request.method() === 'PUT') mutations.push(request); });
  await holdUnsentEdit(page, path, 'retained candidate');
  const head = await fetch(url, { method: 'HEAD' });
  const changed = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'text/plain', 'If-Match': head.headers.get('etag') }, body: foreign });
  expect([200, 204]).toContain(changed.status);
  await page.reload(); await page.waitForFunction(() => window.ready === true); await page.evaluate(() => window.connectStorage());
  await expect.poll(() => page.evaluate(() => window.conflicts.length)).toBe(1);
  let retained = await page.evaluate(async path => (await rs.sync.listInterruptedWrites()).find(node => node.path === path), path);
  expect(retained.push.body).toBe('retained candidate');
  expect(retained.push.operation.base.body).toBe('base');
  expect(retained.push.operation.observed.body).toBe(foreign);
  expect(mutations).toHaveLength(0);
  // A second document must re-expose both candidates without guessing a winner.
  await page.reload(); await page.waitForFunction(() => window.ready === true); await page.evaluate(() => window.connectStorage());
  await expect.poll(() => page.evaluate(() => window.conflicts.length)).toBe(1);
  expect(await page.evaluate(() => window.conflicts[0])).toMatchObject({ oldValue: 'retained candidate', newValue: foreign, lastCommonValue: 'base' });
  expect(mutations).toHaveLength(0);
  retained = await page.evaluate(async path => (await rs.sync.listInterruptedWrites()).find(node => node.path === path), path);
  expect(await page.evaluate(async ({ path, id }) => rs.sync.retryInterruptedWrite(path, id).then(() => 'unexpected-success', error => error.code),
    { path, id: retained.push.operation.id })).toBe('interrupted-write');
  expect(mutations).toHaveLength(0);
  if (foreign !== '') {
    const name = await page.evaluate(({ path, destination }) => 'remotestorage:write:' + JSON.stringify([rs.local.sharedCacheId, destination, path]),
      { path, destination: retained.push.operation.destination });
    const holder = await context.newPage();
    try {
      await holder.goto(address); await holder.waitForFunction(() => window.ready === true);
      await holder.evaluate(name => { navigator.locks.request(name, () => new Promise(resolve => { window.releaseReview = resolve; window.reviewHeld = true; })); }, name);
      await holder.waitForFunction(() => window.reviewHeld);
      await page.evaluate(({ path, id }) => {
        window.resolution = rs.sync.resolveInterruptedWrite(path, id, 'remote').then(() => { window.selectionSucceeded = true; }, error => { window.selectionError = error.message; });
      }, { path, id: retained.push.operation.id });
      await expect.poll(() => page.evaluate(async name => (await navigator.locks.query()).pending.some(lock => lock.name === name), name)).toBe(true);
      await page.evaluate(() => notes.storeFile('text/plain', 'review.txt', 'newer edit while waiting'));
      await holder.evaluate(() => window.releaseReview());
      await page.evaluate(() => window.resolution);
      expect(await page.evaluate(() => window.selectionSucceeded)).toBeUndefined();
      expect(await page.evaluate(() => window.selectionError)).toContain('needs review');
      const latest = await page.evaluate(async path => (await rs.sync.listInterruptedWrites()).find(node => node.path === path), path);
      expect(latest.local.body).toBe('newer edit while waiting');
      expect(latest.push.body).toBe('retained candidate');
      expect(mutations).toHaveLength(0);
    } finally { await holder.close(); }
  }
  await page.evaluate(async ({ path, id, choice }) => rs.sync.resolveInterruptedWrite(path, id, choice),
    { path, id: retained.push.operation.id, choice: foreign === '' ? 'local' : 'remote' });
  if (foreign === '') { await acknowledged(page, path, 'retained candidate'); expect(mutations).toHaveLength(1); }
  else { expect((await (await fetch(url)).text())).toBe(foreign); expect(mutations).toHaveLength(0); }
  await page.evaluate(() => notes.remove('review.txt'));
  await expect.poll(() => fileBodies(path)).toEqual([]);
});

test('non-atomic missing creates stay parked until readback positively identifies the candidate', async ({ page, context, browser }) => {
  const path = '/notes/non-atomic.txt'; await connect(page);
  await page.evaluate(() => {
    const request = rs.lws.request;
    rs.lws.request = async (url, init) => {
      if (init?.method === 'POST' && new Headers(init.headers).get('Content-Type') === 'text/plain') {
        window.createHeld = true; await new Promise(() => {});
      }
      return request(url, init);
    };
    return notes.storeFile('text/plain', 'non-atomic.txt', 'candidate');
  });
  await page.waitForFunction(() => window.createHeld);
  const mutations = [];
  context.on('request', request => { if (['POST', 'PUT'].includes(request.method()) && request.url().startsWith(external || storage.base)) mutations.push(request); });
  await page.reload(); await page.waitForFunction(() => window.ready === true);
  await page.evaluate(() => { Object.defineProperty(rs.lws, 'supportsAtomicCreate', { value: false }); return window.connectStorage(); });
  await expect.poll(() => page.evaluate(async path => (await rs.sync.listInterruptedWrites()).find(node => node.path === path)?.push.operation.state, path)).toBe('conflict');
  const id = await page.evaluate(async path => (await rs.sync.listInterruptedWrites()).find(node => node.path === path).push.operation.id, path);
  expect(await page.evaluate(async ({ path, id }) => rs.sync.resolveInterruptedWrite(path, id, 'local').then(() => 'unexpected-success', error => error.code), { path, id })).toBe('interrupted-write');
  expect(mutations).toHaveLength(0);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage(); await connect(other);
    expect(await other.evaluate(async path => (await rs.lws.put(path, 'candidate', 'text/plain', { ifNoneMatch: '*' })).statusCode, path)).toBe(201);
  } finally { await otherContext.close(); }
  await page.evaluate(({ path, id }) => rs.sync.retryInterruptedWrite(path, id), { path, id });
  await acknowledged(page, path, 'candidate'); expect(mutations).toHaveLength(0);
  await page.evaluate(() => notes.remove('non-atomic.txt'));
  await expect.poll(() => fileBodies(path)).toEqual([]);
});

for (const mode of ['IndexedDB', 'localStorage']) test(mode + ' retains binary pending/base snapshots, empty files and tombstones through document reload', async ({ page }) => {
  if (mode === 'localStorage') await page.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined }); });
  await page.goto(address); await page.waitForFunction(() => window.ready === true);
  await page.evaluate(async () => {
    rs.stopSync();
    await rs.local.setNodes({
      '/notes/binary': { path: '/notes/binary', common: {}, push: { body: new Uint8Array([0, 255]).buffer, contentType: 'application/octet-stream',
        operation: { version: 1, id: 'offline-export', destination: 'offline', owned: false, base: { body: new Uint8Array([1, 2]).buffer, contentType: 'application/octet-stream' } } } },
      '/notes/empty': { path: '/notes/empty', common: { body: '', contentType: 'text/plain' } },
      '/notes/empty-json': { path: '/notes/empty-json', common: { body: '', contentType: 'application/json' } },
      '/notes/deleted': { path: '/notes/deleted', common: { body: 'previous', contentType: 'text/plain' }, local: { body: false },
        push: { body: false, operation: { version: 1, id: 'offline-delete', destination: 'offline', owned: false, base: { body: 'previous', contentType: 'text/plain' } } } },
      '/notes/unknown': { path: '/notes/unknown', common: {} }
    });
  });
  await page.reload(); await page.waitForFunction(() => window.ready === true);
  const result = await page.evaluate(async () => {
    const nodes = await rs.local.getNodes(['/notes/binary', '/notes/empty', '/notes/deleted', '/notes/unknown']);
    let invalidJsonRejected = false;
    try { await notes.getObject('empty-json', false); } catch { invalidJsonRejected = true; }
    return { identity: rs.local.sharedCacheId, invalidJsonRejected,
      pending: [...new Uint8Array(nodes['/notes/binary'].push.body)], base: [...new Uint8Array(nodes['/notes/binary'].push.operation.base.body)],
      visible: [...new Uint8Array((await notes.getFile('binary', false)).data)], empty: await notes.getFile('empty', false),
      deleted: await rs.local.get('/notes/deleted'), pendingDelete: nodes['/notes/deleted'].push.body,
      unknownBody: Object.prototype.hasOwnProperty.call(nodes['/notes/unknown'].common, 'body') };
  });
  expect(result.identity.startsWith(mode === 'IndexedDB' ? 'indexeddb:' : 'localstorage:')).toBe(true);
  expect(result.pending).toEqual([0, 255]); expect(result.base).toEqual([1, 2]); expect(result.visible).toEqual([0, 255]);
  expect(result.empty.data).toBe(''); expect(result.invalidJsonRejected).toBe(true);
  expect(result.deleted.statusCode).toBe(404); expect(result.pendingDelete).toBe(false); expect(result.unknownBody).toBe(false);
});
