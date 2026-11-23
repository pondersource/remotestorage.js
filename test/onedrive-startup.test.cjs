// Optional OneDrive configuration must leave guest storage usable on a named
// HTTP development origin, where the browser deliberately omits crypto.subtle.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { chromium } = require('@playwright/test');

test('optional OneDrive configuration stays lazy on insecure HTTP, including reload', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  await page.addInitScript(() => {
    window.unhandled = [];
    window.addEventListener('unhandledrejection', event => unhandled.push(String(event.reason)));
  });
  const origin = 'http://app.example.test:8000';
  const bundle = readFileSync(require.resolve('../release/remotestorage-all.js'));
  const html = `<!doctype html><script src="/rs.js"></script>
    <button id="connect">Connect OneDrive</button><output id="status">Starting</output><script>
    window.rs = new RemoteStorage({ modules: [{name:'notes',builder(client) {
      client.declareType('note',{type:'object'});
      return {exports:{write:value=>client.storeObject('note','one',value),read:()=>client.getObject('one')}};
    }}] });
    rs.access.claim('notes','rw');rs.caching.enable('/notes/');
    rs.setApiKeys({onedrive:'580dcb92-f05e-4ec9-ac33-48f005b8bd01'});
    rs.on('ready',async()=>{
      const previous=await rs.notes.read();window.previous=previous;
      await rs.notes.write({title:'Guest content'});window.record=await rs.notes.read();
      document.querySelector('#status').textContent='Guest ready';window.ready=true;
    });
    document.querySelector('#connect').onclick=async()=>{
      try {await rs.onedrive.connect();}catch(error){window.connectionError=error.message;}
      await rs.notes.write({title:'Still editable'});window.record=await rs.notes.read();
    };
    </script>`;
  await page.route(origin + '/**', route => route.fulfill({
    contentType: route.request().url().endsWith('/rs.js') ? 'text/javascript' : 'text/html',
    body: route.request().url().endsWith('/rs.js') ? bundle : html
  }));
  await page.goto(origin);
  await page.waitForFunction(() => window.ready);
  assert.equal(await page.evaluate(() => isSecureContext), false);
  assert.equal(await page.evaluate(() => !!crypto.subtle), false);
  assert.equal(await page.locator('#status').textContent(), 'Guest ready');
  assert.equal(await page.evaluate(() => record.title), 'Guest content');
  assert.equal(await page.evaluate(() => rs.onedrive.auth), undefined);
  await page.reload();
  await page.waitForFunction(() => window.ready);
  assert.equal(await page.evaluate(() => previous.title), 'Guest content');
  assert.equal(await page.evaluate(() => rs.onedrive.auth), undefined);
  await page.locator('#connect').click();
  await page.waitForFunction(() => window.connectionError && record.title === 'Still editable');
  assert.match(await page.evaluate(() => connectionError), /secure context.*HTTPS or localhost/);
  assert.equal(await page.evaluate(() => rs.onedrive.auth), undefined);
  assert.equal(await page.evaluate(() => rs.backend), 'remotestorage');
  // A remembered provider also needs an explicit reconnect: tokens are kept
  // only in memory, so restoring its label must not initialize MSAL on HTTP.
  await page.evaluate(() => localStorage.setItem('remotestorage:backend', 'onedrive'));
  await page.reload();
  await page.waitForFunction(() => window.ready);
  assert.equal(await page.evaluate(() => rs.backend), 'onedrive');
  assert.equal(await page.evaluate(() => rs.onedrive.connected), false);
  assert.equal(await page.evaluate(() => rs.onedrive.auth), undefined);
  assert.equal(await page.evaluate(() => record.title), 'Guest content');
  assert.deepEqual(await page.evaluate(() => unhandled), []);
  assert.deepEqual(errors, []);
  assert.equal(requests.some(url => /microsoftonline|graph\.microsoft/.test(url)), false);
});
