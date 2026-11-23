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
      window.ready = false; window.errors = [];
      window.rs = new RemoteStorage({ disableFeatures: ['Solid', 'Dropbox', 'GoogleDrive'] });
      rs.access.claim('notes', 'rw'); rs.caching.enable('/notes/');
      window.notes = rs.scope('/notes/');
      rs.on('error', error => window.errors.push(error.message));
      rs.on('ready', () => { window.ready = true; });
      window.connectStorage = async () => { rs.lws.setStorageURL(${JSON.stringify(external || storage.base + '/storage')}); await rs.lws.connect(); };
    </script></body></html>`);
  });
  await new Promise(resolve => app.listen(Number(process.env.LWS_APP_PORT || 0), '127.0.0.1', resolve));
  address = 'http://127.0.0.1:' + app.address().port;
});
test.afterAll(async () => { await storage.close(); await new Promise(resolve => app.close(resolve)); });
async function connect(page) {
  const messages = []; page.on('pageerror', error => messages.push(error.message));
  await page.goto(address);
  try { await page.waitForFunction(() => window.ready === true); }
  catch (error) { throw new Error(error.message + '\nBrowser errors: ' + messages.join('\n')); }
  await page.evaluate(() => window.connectStorage());
}
const fileBodies = async () => {
  if (!external) return [...storage.resources.values()].filter(r => r.type === 'text/plain').map(r => r.body);
  const response = await fetch(external, { headers: { Accept: 'application/lws+json' } });
  const root = await response.json();
  const index = root.items.find(item => item.format?.split(';')[0] === 'application/vnd.remotestorage.lws-index+json');
  if (!index) return [];
  const map = await (await fetch(new URL(index.id, external))).json();
  const url = map.entries['/notes/a.txt'];
  if (!url) return [];
  const file = await fetch(url);
  return file.status === 404 ? [] : [await file.text()];
};

test('the real rs.js cache syncs offline edits and a new browser pulls them from opaque LWS URLs', async ({ page, context, browser }) => {
  await connect(page);
  await page.evaluate(() => notes.storeFile('text/plain', 'a.txt', 'first revision'));
  await expect.poll(fileBodies, { timeout: 20000 }).toEqual(['first revision']);

  await page.evaluate(() => rs.stopSync());
  await context.setOffline(true);
  await page.evaluate(() => notes.storeFile('text/plain', 'a.txt', 'edited while offline'));
  expect(await page.evaluate(async () => (await notes.getFile('a.txt')).data)).toBe('edited while offline');
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
