const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require('@playwright/test');

async function attach(page) {
  await page.evaluate(() => native.attachAdapter());
  await page.locator('iframe').waitFor();
  const frame = page.frames().find(item => item.parentFrame());
  await frame.waitForURL(url => url.pathname === '/adapter.html' && url.searchParams.get('rs-nextgraph-wallet') === 'https://nextgraph.net');
  await frame.waitForFunction(() => window.adapterReady || window.adapterError);
  const error = await frame.evaluate(() => window.adapterError);
  assert.equal(error, undefined);
  return frame;
}

async function boot(page, url, create = false) {
  await page.goto(url);
  await page.waitForFunction(() => window.fixtureReady);
  await page.evaluate(fresh => fresh ? native.create() : native.reopen(), create);
  if (create) { await page.evaluate(() => native.prepareAdapterCollection()); }
  return attach(page);
}

test('actual adapter acknowledges committed journal recovery across native storage failure, reload, tab close and browser restart', { timeout: 360000 }, async t => {
  const { prepareNativeEngine } = await import('../scripts/run-nextgraph-native-engine.mjs');
  const fixture = await prepareNativeEngine({ adapter: true });
  const url = fixture.url.replace('127.0.0.1', 'localhost');
  const profile = await mkdtemp(join(tmpdir(), 'rs-nextgraph-adapter-profile-'));
  const evidence = [];
  let context;
  try {
    context = await chromium.launchPersistentContext(profile);
    let page = context.pages()[0];
    let frame = await boot(page, url, true);
    const text = '{ "unknown": [1, 2], "title": "preserve exact bytes" }\n';
    const first = await frame.evaluate(value => adapter.put('/notes/a', value, 'application/json'), text);
    assert.equal(first.statusCode, 201);
    assert.equal((await frame.evaluate(() => adapter.get('/notes/a'))).body, text);
    const conflict = await frame.evaluate(async () => {
      const archive = await adapter.exportRecovery();
      const base = archive.records.find(record => record.path === '/notes/a');
      const branch = { ...base, id: crypto.randomUUID(), parents: [], created: Date.now() };
      await adapter.importRecovery({ ...archive, records: [branch] });
      const response = await adapter.get('/notes/a');
      const heads = adapter.getConflicts('/notes/a');
      await adapter.resolveConflict('/notes/a', base.id, heads.map(record => record.id));
      await adapter.put('/notes/gone', 'deleted candidate', 'text/plain');
      await adapter.delete('/notes/gone');
      return { status: response.statusCode, count: heads.length, resolved: (await adapter.get('/notes/a')).body };
    });
    assert.equal(conflict.status, 409); assert.equal(conflict.count, 2); assert.equal(conflict.resolved, text);
    t.diagnostic('Actual ORM and journal preserve concurrent history, resolution and tombstone');

    await page.evaluate(() => native.failOutboxWrites(true));
    const local = await frame.evaluate(() => adapter.put('/notes/native-quota', 'journal survives native failure', 'text/plain'));
    assert.equal(local.statusCode, 201);
    const nativeFailure = await page.evaluate(() => native.snapshot());
    assert.ok(nativeFailure.failedOutboxWrites > 0);
    assert.equal((await frame.evaluate(() => adapter.get('/notes/native-quota'))).body, 'journal survives native failure');
    await page.evaluate(() => native.failOutboxWrites(false));
    evidence.push({ boundary: 'native-outbox-failure', localAck: true, realStorageFailures: nativeFailure.failedOutboxWrites, journalReadback: true });

    const quota = await frame.evaluate(async () => {
      const add = IDBObjectStore.prototype.add;
      const transaction = IDBDatabase.prototype.transaction;
      let attempted = 0, terminal = false;
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        tx.addEventListener('abort', () => { terminal = true; });
        return tx;
      };
      IDBObjectStore.prototype.add = function (...args) {
        if (this.name === 'revisions' && JSON.parse(args[0].record).path === '/notes/rejected') {
          attempted++;
          throw new DOMException('Injected journal quota failure', 'QuotaExceededError');
        }
        return add.apply(this, args);
      };
      let error;
      try { await adapter.put('/notes/rejected', 'must not ACK', 'text/plain'); }
      catch (value) { error = value.name; }
      finally { IDBObjectStore.prototype.add = add; IDBDatabase.prototype.transaction = transaction; }
      return { error, attempted, terminal, status: (await adapter.get('/notes/rejected')).statusCode };
    });
    assert.deepEqual(quota, { error: 'QuotaExceededError', attempted: 1, terminal: true, status: 404 });
    evidence.push({ boundary: 'journal-quota-failure', ...quota, localAck: false });

    const batch = await frame.evaluate(async () => {
      const archive = await adapter.exportRecovery();
      const base = archive.records.find(record => !record.deleted);
      const records = ['a', 'b'].map(name => ({ ...base, id: crypto.randomUUID(), path: '/notes/batch-' + name, parents: [] }));
      const add = IDBObjectStore.prototype.add;
      const transaction = IDBDatabase.prototype.transaction;
      let attempted = 0, terminal = false;
      IDBDatabase.prototype.transaction = function (...args) {
        const tx = transaction.apply(this, args);
        tx.addEventListener('abort', () => { terminal = true; });
        return tx;
      };
      IDBObjectStore.prototype.add = function (value, ...args) {
        if (this.name === 'revisions' && ++attempted === 2) {
          // The real browser IndexedDB implementation raises DataCloneError.
          return add.call(this, { ...value, uncloneable: () => {} }, ...args);
        }
        return add.call(this, value, ...args);
      };
      let error;
      try { await adapter.importRecovery({ ...archive, records }); }
      catch (value) { error = value.name; }
      finally { IDBObjectStore.prototype.add = add; IDBDatabase.prototype.transaction = transaction; }
      const after = await adapter.exportRecovery();
      return { error, attempted, terminal, before: archive.records.length, after: after.records.length,
        leaked: after.records.some(record => record.path.startsWith('/notes/batch-')) };
    });
    assert.equal(batch.error, 'DataCloneError'); assert.equal(batch.attempted, 2); assert.equal(batch.terminal, true);
    assert.equal(batch.before, batch.after); assert.equal(batch.leaked, false);
    evidence.push({ boundary: 'real-partial-batch-abort', ...batch });
    const recovery = await frame.evaluate(() => adapter.exportRecovery());
    assert.equal(recovery.records.length, 6);
    assert.ok(recovery.records.some(record => record.deleted));
    t.diagnostic('Native quota error is covered by durable archive; journal quota/DataCloneError reject only after real abort');

    async function verifyRecovered(boundary) {
      assert.equal((await frame.evaluate(() => adapter.get('/notes/a'))).body, text);
      assert.equal((await frame.evaluate(() => adapter.get('/notes/native-quota'))).body, 'journal survives native failure');
      assert.equal((await frame.evaluate(() => adapter.get('/notes/gone'))).statusCode, 404);
      const archive = await frame.evaluate(() => adapter.exportRecovery());
      assert.deepEqual(archive, recovery);
      assert.equal(await frame.evaluate(() => adapter.deliveryState), 'needs-attention');
      const counts = await page.evaluate(() => native.rpcCounts());
      assert.equal(counts.doc_create || 0, 0, 'Unavailable native discovery must not create another collection');
      evidence.push({ boundary, journalReadback: true, allVersionsAndTombstones: archive.records.length, extraCollectionsCreated: 0 });
      t.diagnostic(boundary + ': exact bytes, all versions and tombstone recovered without creating a collection');
    }

    frame = await boot(page, url);
    await verifyRecovered('same-tab-reload');
    await page.close(); page = await context.newPage();
    frame = await boot(page, url);
    await verifyRecovered('tab-close');
    await page.close(); await context.close();
    context = await chromium.launchPersistentContext(profile); page = context.pages()[0];
    frame = await boot(page, url);
    await verifyRecovered('cold-browser-restart');

    const again = await frame.evaluate(() => adapter.put('/notes/a', 'edited while native graph unavailable', 'text/plain'));
    assert.equal(again.statusCode, 200);
    assert.equal((await frame.evaluate(() => adapter.get('/notes/a'))).body, 'edited while native graph unavailable');
    evidence.push({ boundary: 'cold-offline-edit', localAck: true, journalReadback: true });

    await page.evaluate(() => native.saveSelection());
    await page.evaluate(() => native.create());
    await page.evaluate(() => native.prepareAdapterCollection());
    frame = await attach(page);
    assert.equal((await frame.evaluate(() => adapter.get('/notes/native-quota'))).statusCode, 404);
    const mismatch = await frame.evaluate(async snapshot => {
      try { await adapter.importRecovery(snapshot); return false; } catch { return true; }
    }, recovery);
    assert.equal(mismatch, true);
    await page.evaluate(() => native.restoreSelection());
    frame = await attach(page);
    assert.equal((await frame.evaluate(() => adapter.get('/notes/a'))).body, 'edited while native graph unavailable');
    evidence.push({ boundary: 'native-account-isolation', otherAccountDataHidden: true, mismatchedImportRejected: true, originalCandidatePreserved: true });
  } finally {
    if (process.env.NEXTGRAPH_ADAPTER_REPORT) {
      await writeFile(process.env.NEXTGRAPH_ADAPTER_REPORT, JSON.stringify({ provenance: fixture.pins, localWebBuild: 'NG_DEV_LOCAL_BROKER=1', evidence,
        limits: ['Native consent UI and real broker replication remain separate acceptance gates.', 'Journal is plaintext browser-local recovery; SDK session/peer sequence storage was not changed.'] }, null, 2) + '\n');
    }
    await context?.close(); await fixture.close(); await rm(profile, { recursive: true, force: true });
  }
});

test('preview6 native-acknowledged IndexedDB cache survives uncertain first journal connection and remains explicitly exportable', { timeout: 90000 }, async () => {
  const { prepareNativeEngine } = await import('../scripts/run-nextgraph-native-engine.mjs');
  const fixture = await prepareNativeEngine({ adapter: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(fixture.url.replace('127.0.0.1', 'localhost'));
    await page.waitForFunction(() => window.fixtureReady);
    await page.evaluate(() => native.create());
    // This wallet's native graph has no collection marker, while its old rs.js
    // cache carries acknowledged data. Never guess ownership or create anew.
    await page.evaluate(() => native.attachAdapter('upgrade'));
    await page.locator('iframe').waitFor();
    const frame = page.frames().find(item => item.parentFrame());
    await frame.waitForURL(url => url.pathname === '/adapter.html' && url.searchParams.get('upgrade') === '1');
    await frame.waitForFunction(() => window.adapterError);
    assert.match(await frame.evaluate(() => adapterError), /Existing cached documents need explicit recovery/);
    const recovered = await frame.evaluate(async () => ({
      connected: adapter.connected,
      cached: await actualCache.get('/notes/preview6.json'),
      node: (await actualCache.getNodes(['/notes/preview6.json']))['/notes/preview6.json'],
      exported: await adapter.exportSnapshot(),
      cacheRecovery: await adapter.exportCacheRecovery(),
    }));
    assert.equal(recovered.connected, false);
    assert.equal(recovered.cached.statusCode, 200);
    assert.equal(recovered.cached.body, '{ "unknown": true, "saved": "native acknowledged" }\n');
    assert.equal(recovered.node.common.revision, 'preview6-native-ack');
    assert.equal(recovered.node.local, undefined);
    assert.equal(recovered.exported.records.length, 1);
    assert.equal(recovered.exported.records[0].path, '/notes/preview6.json');
    assert.equal(recovered.cacheRecovery.candidates.length, 1);
    assert.equal(recovered.cacheRecovery.candidates[0].source, 'common');
    assert.equal(recovered.cacheRecovery.candidates[0].revision, 'preview6-native-ack');
    assert.equal((await page.evaluate(() => native.rpcCounts())).doc_create || 0, 0);
  } finally { await browser.close(); await fixture.close(); }
});

test('same-origin tabs serialize first collection selection and atomically enforce journal preconditions', { timeout: 120000 }, async t => {
  const { prepareNativeEngine } = await import('../scripts/run-nextgraph-native-engine.mjs');
  const fixture = await prepareNativeEngine({ adapter: true });
  const url = fixture.url.replace('127.0.0.1', 'localhost');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const first = await context.newPage();
    await first.goto(url); await first.waitForFunction(() => window.fixtureReady);
    await first.evaluate(() => native.create());
    await first.evaluate(() => native.prepareAdapterCollection());
    const second = await context.newPage();
    await second.goto(url); await second.waitForFunction(() => window.fixtureReady);
    await second.evaluate(() => native.reopen());
    // Delay only transport dispatch; the response still comes from the real
    // native query. The second tab cannot enter selection until the first
    // publishes its genuine collection identity in the durable catalogue.
    await first.evaluate(() => native.pauseDiscovery());
    await first.evaluate(() => native.attachAdapter());
    await first.waitForFunction(() => window.nativeQueryPaused);
    await second.evaluate(() => native.attachAdapter());
    await second.locator('iframe').waitFor();
    const secondFrame = second.frames().find(item => item.parentFrame());
    await secondFrame.waitForURL(url => url.pathname === '/adapter.html');
    await secondFrame.waitForFunction(async () => (await navigator.locks.query()).pending.some(lock => lock.name.startsWith('remotestorage:nextgraph-collection:')));
    assert.equal((await second.evaluate(() => native.rpcCounts())).sparql_query || 0, 0);
    await first.evaluate(() => native.releaseDiscovery());
    const firstFrame = first.frames().find(item => item.parentFrame());
    await firstFrame.waitForFunction(() => window.adapterReady || window.adapterError);
    await secondFrame.waitForFunction(() => window.adapterReady || window.adapterError);
    assert.equal(await firstFrame.evaluate(() => window.adapterError), undefined);
    assert.equal(await secondFrame.evaluate(() => window.adapterError), undefined);
    assert.equal(await firstFrame.evaluate(() => adapter.getStorageIdentity()), await secondFrame.evaluate(() => adapter.getStorageIdentity()));
    const results = await Promise.all([
      firstFrame.evaluate(() => adapter.put('/notes/race', 'first', 'text/plain', { ifNoneMatch: '*' })),
      secondFrame.evaluate(() => adapter.put('/notes/race', 'second', 'text/plain', { ifNoneMatch: '*' })),
    ]);
    assert.deepEqual(results.map(result => result.statusCode).sort(), [201, 412]);
    const winner = await firstFrame.evaluate(() => adapter.get('/notes/race'));
    assert.equal(winner.statusCode, 200);
    assert.equal((await secondFrame.evaluate(() => adapter.get('/notes/race'))).body, winner.body);
    assert.equal((await first.evaluate(() => native.rpcCounts())).doc_create || 0, 0);
    assert.equal((await second.evaluate(() => native.rpcCounts())).doc_create || 0, 0);
    t.diagnostic('A real Web Lock queued the second tab; both chose one native identity and one create condition succeeded');
  } finally { await browser.close(); await fixture.close(); }
});
