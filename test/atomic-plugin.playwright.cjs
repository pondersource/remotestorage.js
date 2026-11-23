// This opt-in journey uses the real Atomic plugin installation/consent UI.
// Its upstream setup helpers belong to the pinned ontola/atomic-plugins checkout.
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const atomic = process.env.ATOMIC_SERVER_CHECKOUT;
const plugins = process.env.ATOMIC_PLUGINS_CHECKOUT;
if (!atomic || !plugins) throw new Error('Set ATOMIC_SERVER_CHECKOUT and ATOMIC_PLUGINS_CHECKOUT.');
const atomicRequire = createRequire(resolve(atomic, 'browser/e2e/package.json'));
const { test, expect } = atomicRequire('@playwright/test');
const { before, getDevDriveSecret, signIn, SERVER_URL } = require(resolve(atomic, 'browser/e2e/tests/test-utils.ts'));
const { enableIntegrationDiscovery } = require(resolve(atomic, 'browser/e2e/tests/integration-settings-utils.ts'));
const { installServer, install, post, routeSlug, ROUTES_ORIGIN } = require(resolve(plugins, 'integrations/remotestorage/e2e/helpers.ts'));
const bundle = readFileSync(process.env.ATOMIC_RS_BUNDLE || resolve(__dirname, '../release/remotestorage-all.js'));
const widget = readFileSync(process.env.ATOMIC_WIDGET_BUNDLE || resolve(__dirname, '../../remotestorage-widget/build/widget.js'));
let app, address;
test.beforeAll(async () => {
  app = createServer((request, response) => {
    const script = request.url === '/rs.js' ? bundle : request.url === '/widget.js' ? widget : undefined;
    response.writeHead(200, { 'Content-Type': script ? 'application/javascript' : 'text/html; charset=utf-8' });
    response.end(script || `<!doctype html><meta charset="utf-8"><title>Atomic native consent acceptance</title>
      <div id="storage"></div><script src="/rs.js"></script><script src="/widget.js"></script><script>
      window.errors=[]; window.ready=false;
      window.rs=new RemoteStorage(); rs.access.claim('notes','rw'); rs.caching.enable('/notes/');
      window.notes=rs.scope('/notes/'); rs.on('ready',()=>window.ready=true);
      rs.on('error',error=>errors.push(error.message));
      window.widget=new Widget(rs,{skipInitial:true,leaveOpen:true}); widget.attach('storage');
      </script>`);
  });
  await new Promise(resolve => app.listen(0, resolve));
  address = `http://rs-app.localhost:${app.address().port}`;
});
test.afterAll(async () => { if (app) await new Promise(resolve => app.close(resolve)); });
async function connect(page, storageAddress) {
  await page.goto(address);
  await expect(page.locator('.rs-choose-atomic')).toBeVisible();
  await page.locator('.rs-choose-atomic').click();
  await page.locator('[name=rs-user-address]').fill(storageAddress);
  await page.locator('.rs-connect').click();
  await page.waitForURL(/\/app\/route-consent\?request=/);
  await expect(page.getByText('notes:rw')).toBeVisible();
  await expect(page.getByText(address, { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await page.waitForURL(`${address}/**`);
  await page.waitForFunction(() => ready && rs.remote.connected);
}
test('Atomic native consent retains scoped document bytes across reload and a fresh browser', async ({ page, browser }) => {
  test.setTimeout(300000);
  let secret, origin;
  if (process.env.ATOMIC_NATIVE_BOOTSTRAP) {
    // Supported native Rust bootstrap only creates the disposable account,
    // drive and plugin draft. Installation review and app consent stay real UI.
    const bootstrap = JSON.parse(readFileSync(process.env.ATOMIC_NATIVE_BOOTSTRAP, 'utf8'));
    secret = bootstrap.secret;
    await page.goto(SERVER_URL + '/app/welcome');
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor({ timeout: 60000 });
    await signIn(page, secret);
    await page.evaluate(drive => window.store.setDrive(drive), bootstrap.drive);
    await page.goto(SERVER_URL + '/app?subject=' + encodeURIComponent(bootstrap.drive));
    await enableIntegrationDiscovery(page);
    const { Agent } = atomicRequire('@tomic/lib');
    const published = await post(Agent.fromSecret(secret, 'js'), '/plugin-release', { drive: bootstrap.drive, plugin: bootstrap.plugin });
    expect(published.status).toBe(200);
    const installation = await install(page, published.json.id, bootstrap.folder);
    origin = ROUTES_ORIGIN.replace('://', `://${routeSlug(installation)}.`);
  } else {
    await before({ page });
    await enableIntegrationDiscovery(page);
    secret = await getDevDriveSecret(page);
    ({ origin } = await installServer(page, 'Ponder Source native remoteStorage acceptance'));
  }
  const storageAddress = `me@${new URL(origin).host}`;
  await connect(page, storageAddress);
  const source = '{\n  "title": "Native Atomic", "unknown": [1, true, null]\n}\n';
  const mime = 'application/json; charset=UTF-8; profile="https://example.test/native"';
  const binary = [0, 255, 1, 250, 0, 13, 10];
  await page.evaluate(async ({ source, mime, binary }) => {
    await notes.storeFile(mime, 'native.json', source);
    await notes.storeFile('application/octet-stream', 'native.bin', new Uint8Array(binary).buffer);
    await rs.startSync();
  }, { source, mime, binary });
  await page.waitForFunction(async () => {
    const nodes = await rs.local.getNodes(['/notes/native.json', '/notes/native.bin']);
    return Object.values(nodes).every(node => node?.common?.revision && !node.local && !node.push);
  });
  const read = async target => target.evaluate(async () => {
    const json = await notes.getFile('native.json', false);
    const binary = await notes.getFile('native.bin', false);
    return { json: json.data, mime: json.contentType, binary: Array.from(new Uint8Array(binary.data)) };
  });
  expect(await read(page)).toEqual({ json: source, mime, binary });
  const fences = await page.evaluate(async () => {
    const root = rs.remote.href.replace(/\/$/, '');
    return {
      private: (await fetch(root + '/notes/native.json')).status,
      other: (await fetch(root + '/other/no.txt', { headers: { Authorization: 'Bearer ' + rs.remote.token } })).status,
    };
  });
  expect(fences.private).toBe(401);
  expect(fences.other).toBe(403);
  // Keep the application reachable while its actual storage provider is unavailable.
  // This exercises durable rs.js state rather than a fabricated local cache adapter.
  const unavailable = route => route.abort('internetdisconnected');
  await page.context().route(origin + '/storage/**', unavailable);
  const updated = source.replace('Native Atomic', 'Native Atomic after interrupted connection');
  const failedWrite = page.waitForEvent('requestfailed', request =>
    request.method() === 'PUT' && request.url().endsWith('/notes/native.json'));
  await page.evaluate(async ({ updated, mime }) => {
    await notes.storeFile(mime, 'native.json', updated);
    rs.startSync();
  }, { updated, mime });
  await failedWrite;
  await page.reload();
  await page.waitForFunction(() => ready && rs.remote.connected);
  expect(await page.evaluate(async () => (await notes.getFile('native.json')).data)).toBe(updated);
  await page.context().unroute(origin + '/storage/**', unavailable);
  await page.evaluate(() => rs.startSync());
  await page.waitForFunction(async expected => {
    const node = (await rs.local.getNodes(['/notes/native.json']))['/notes/native.json'];
    return node?.common?.body === expected && !node.local && !node.push;
  }, updated);
  expect(await read(page)).toEqual({ json: updated, mime, binary });
  const fresh = await browser.newContext();
  try {
    const second = await fresh.newPage();
    await second.goto(SERVER_URL + '/app/welcome');
    await signIn(second, secret);
    await connect(second, storageAddress);
    await expect.poll(() => read(second), { timeout: 30000 }).toEqual({ json: updated, mime, binary });
  } finally { await fresh.close(); }
  // Exercise the real plugin/host commit boundary, not an in-memory ctx stub.
  const race = await page.evaluate(async () => {
    const url = rs.remote.href.replace(/\/$/, '') + '/notes/race.txt';
    const headers = { Authorization: 'Bearer ' + rs.remote.token };
    const created = await fetch(url, { method: 'PUT', body: 'base', headers: {
      ...headers, 'Content-Type': 'text/plain; charset=UTF-8', 'If-None-Match': '*',
    } });
    if (created.status !== 201) throw Error('Race baseline create failed: HTTP ' + created.status);
    const baseline = await fetch(url, { headers, cache: 'no-store' });
    const revision = baseline.headers.get('etag');
    if (!baseline.ok || !revision) throw Error('Race baseline must have a live ETag: HTTP ' + baseline.status);
    const results = await Promise.all(['writer-a', 'writer-b'].map(body => fetch(url, {
      method: 'PUT', body, headers: { ...headers, 'Content-Type': 'text/plain; charset=UTF-8', 'If-Match': revision },
    }).then(response => response.status)));
    return { results, winner: await (await fetch(url, { headers })).text() };
  });
  expect(race.results.filter(status => status >= 200 && status < 300)).toHaveLength(1);
  expect(race.results.filter(status => status === 412)).toHaveLength(1);
  expect(['writer-a', 'writer-b']).toContain(race.winner);
});
