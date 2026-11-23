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
  await page.evaluate(() => window.interruptAcknowledgement());
  await page.waitForFunction(() => window.errors.length > 0 && !Object.keys(rs.sync._running).length);
  expect(await page.evaluate(async () => (await notes.getFile('uncertain.txt', false)).data)).toBe('edited while offline');

  await context.setOffline(false);
  await page.evaluate(() => rs.startSync());
  await expect.poll(() => page.evaluate(() => window.conflicts.length)).toBe(1);
  const conflict = await page.evaluate(() => window.conflicts[0]);
  expect(conflict.oldValue).toBe('edited while offline');
  expect(conflict.newValue).toBe('first revision');
  expect(conflict.lastCommonValue).toBeUndefined();
  expect(await page.evaluate(() => ({ puts: window.putAttempts, gets: window.getAttempts }))).toEqual({ puts: 2, gets: 1 });
  expect(await fileBodies('/notes/uncertain.txt')).toEqual(['first revision']);

  // rs.js exposes the two versions; only an explicit application decision
  // writes its chosen candidate back with the reviewed remote validator.
  await page.evaluate(() => notes.storeFile('text/plain', 'uncertain.txt', window.conflicts[0].oldValue));
  await expect.poll(() => fileBodies('/notes/uncertain.txt'), { timeout: 20000 }).toEqual(['edited while offline']);
  await acknowledged(page, '/notes/uncertain.txt', 'edited while offline');
  await page.evaluate(() => notes.remove('uncertain.txt'));
  await expect.poll(() => fileBodies('/notes/uncertain.txt'), { timeout: 20000 }).toEqual([]);
});
