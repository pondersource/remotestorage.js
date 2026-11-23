const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { chromium } = require('@playwright/test');

let fixture;
let browser;
const results = [];

async function open(page) {
  await page.goto(fixture.url);
  await page.waitForFunction(() => window.fixtureReady);
}

async function createDocument(page, value) {
  await open(page);
  await page.evaluate(() => native.create());
  await page.evaluate(() => native.openDocument(true));
  const before = await page.evaluate(() => native.snapshot());
  const committed = await page.evaluate(item => native.edit(item), value);
  assert.ok(committed.outboxEntries > before.outboxEntries, 'Native commit must add encrypted outbox events');
  const engineDocument = await page.evaluate(() => native.readEngineDocument());
  assert.deepEqual(engineDocument, committed.document, 'Independent native subscription must read the committed ORM data');
  return { ...committed, independentEngineReadMatched: true };
}

async function attemptOpen(page) {
  try {
    return { opened: true, document: await page.evaluate(() => native.openDocument()) };
  } catch (error) {
    assert.match(error.message, /Native ORM document did not reopen offline/);
    return { opened: false, reason: 'Native ORM document did not reopen offline' };
  }
}

before(async () => {
  const { prepareNativeEngine } = await import('../scripts/run-nextgraph-native-engine.mjs');
  fixture = await prepareNativeEngine();
  browser = await chromium.launch();
});

after(async () => {
  const report = {
    provenance: fixture?.pins,
    evidence: results,
    limits: [
      'Disposable wallets only; no native wallet consent UI was accepted.',
      'No ngd broker ran: post-handshake delivery, replication and broker durability remain untested.',
      'A failed connection does not exercise send_outbox after a successful handshake.',
      'Browser storage was not replaced; the sole injected fault throws from real sessionStorage writes.',
    ],
  };
  if (process.env.NEXTGRAPH_NATIVE_REPORT) {
    await writeFile(process.env.NEXTGRAPH_NATIVE_REPORT, JSON.stringify(report, null, 2) + '\n');
  }
  await browser?.close();
  await fixture?.close();
});

test('actual ORM commit queues encrypted events; same-tab reload preserves outbox but cannot reopen offline graph', { timeout: 60000 }, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const committed = await createDocument(page, 'same-tab-candidate');
    assert.equal(committed.document.record, 'same-tab-candidate');
    assert.ok(committed.outboxEntries > 1);
    assert.ok(committed.local.ng_wallets.bytes > 0);
    await page.reload();
    await page.waitForFunction(() => window.fixtureReady);
    await page.evaluate(() => native.reopen());
    const reopened = await attemptOpen(page);
    const afterReload = await page.evaluate(() => native.snapshot());
    assert.equal(reopened.opened, false);
    assert.equal(afterReload.outboxDigest, committed.outboxDigest);
    assert.equal(afterReload.outboxEntries, committed.outboxEntries);
    results.push({ boundary: 'same-tab-reload', commitResolved: true, before: committed, after: afterReload, reopened });
  } finally { await context.close(); }
});

test('closing a tab keeps native wallet but loses pending sessionStorage events and offline graph', { timeout: 60000 }, async () => {
  const context = await browser.newContext();
  try {
    const first = await context.newPage();
    const committed = await createDocument(first, 'closed-tab-candidate');
    // Keep an independent explicit export before intentionally closing the disposable tab.
    const exported = await first.evaluate(() => native.exportDocument());
    await first.close();
    const next = await context.newPage();
    await open(next);
    await next.evaluate(() => native.reopen());
    const afterClose = await next.evaluate(() => native.snapshot());
    assert.ok(afterClose.local.ng_wallets.bytes > 0);
    assert.equal(afterClose.outboxEntries, 0);
    const reopened = await attemptOpen(next);
    assert.equal(reopened.opened, false);
    assert.deepEqual(exported, committed.document);
    results.push({ boundary: 'tab-close', commitResolved: true, before: committed, after: afterClose, reopened, explicitExportPreserved: true });
  } finally { await context.close(); }
});

test('cold persistent-browser restart retains wallet but cannot recover an unreplicated committed edit', { timeout: 60000 }, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'rs-ng-native-profile-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile);
    const page = context.pages()[0];
    const committed = await createDocument(page, 'cold-browser-candidate');
    const exported = await page.evaluate(() => native.exportDocument());
    // Close the page first: this does not ask Chromium to restore its session on restart.
    await page.close();
    await context.close();
    context = await chromium.launchPersistentContext(profile);
    const next = context.pages()[0];
    await open(next);
    await next.evaluate(() => native.reopen());
    const afterRestart = await next.evaluate(() => native.snapshot());
    assert.ok(afterRestart.local.ng_wallets.bytes > 0);
    assert.equal(afterRestart.outboxEntries, 0);
    const reopened = await attemptOpen(next);
    assert.equal(reopened.opened, false);
    assert.deepEqual(exported, committed.document);
    results.push({ boundary: 'cold-browser-restart', commitResolved: true, before: committed, after: afterRestart, reopened, explicitExportPreserved: true });
  } finally { await context?.close(); await rm(profile, { recursive: true, force: true }); }
});

test('native wallet export/import carries keys, while explicit document export/import preserves the actual ORM data', { timeout: 60000 }, async () => {
  const source = await browser.newContext();
  const imported = await browser.newContext();
  const restored = await browser.newContext();
  try {
    const first = await source.newPage();
    const committed = await createDocument(first, 'exported-document-candidate');
    const walletFile = await first.evaluate(() => native.exportWallet());
    const documentId = await first.evaluate(() => native.documentId());
    const documentExport = await first.evaluate(() => native.exportDocument());
    const walletPage = await imported.newPage();
    await open(walletPage);
    await walletPage.evaluate(({ bytes, id }) => native.importWallet(bytes, id), { bytes: walletFile, id: documentId });
    const walletOnly = await attemptOpen(walletPage);
    assert.equal(walletOnly.opened, false);
    const dataPage = await restored.newPage();
    await open(dataPage);
    await dataPage.evaluate(() => native.create());
    const roundTrip = await dataPage.evaluate(value => native.importDocument(value), documentExport);
    assert.deepEqual(roundTrip.document, committed.document);
    assert.ok(roundTrip.outboxEntries > 0);
    results.push({ boundary: 'export-import', walletImported: true, walletOnly, explicitDocumentRoundTrip: true, document: roundTrip.document });
  } finally { await source.close(); await imported.close(); await restored.close(); }
});

test('real outbox storage failure is swallowed by native ORM completion; explicit export preserves the visible candidate', { timeout: 60000 }, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const before = await createDocument(page, 'acknowledged-local-candidate');
    await page.evaluate(() => native.failOutboxWrites(true));
    let rejected = false;
    try { await page.evaluate(() => native.edit('unpersisted-candidate')); }
    catch (error) {
      assert.match(error.message, /JsStorageWriteError|Injected outbox storage failure/);
      rejected = true;
    }
    const afterFailure = await page.evaluate(() => native.snapshot());
    const exported = await page.evaluate(() => native.exportDocument());
    const engineDocument = await page.evaluate(() => native.readEngineDocument());
    assert.equal(afterFailure.document.record, 'unpersisted-candidate');
    assert.equal(afterFailure.outboxDigest, before.outboxDigest);
    assert.equal(afterFailure.failedOutboxWrites, 1);
    assert.deepEqual(engineDocument, afterFailure.document, 'Native memory already changed before persistence failed');
    assert.equal(rejected, false, 'Pinned native WASM unexpectedly changed its error propagation contract');
    assert.deepEqual(exported, afterFailure.document);
    await page.evaluate(() => native.failOutboxWrites(false));
    results.push({ boundary: 'outbox-storage-failure', commitRejected: rejected, commitResolvedDespiteStorageError: !rejected, nativeMemoryChanged: true, candidatePreservedByExplicitExport: true, before, after: afterFailure });
  } finally { await context.close(); }
});

test('durability acceptance gate: completed native commits must survive lifecycle boundaries and reject failed persistence', {
  skip: process.env.NEXTGRAPH_REQUIRE_DURABLE !== '1' && 'Opt in with NEXTGRAPH_REQUIRE_DURABLE=1; pinned engine currently fails this contract',
}, () => {
  const violations = results.filter(result =>
    ['same-tab-reload', 'tab-close', 'cold-browser-restart'].includes(result.boundary)
      ? !result.reopened.opened
      : result.boundary === 'outbox-storage-failure' && !result.commitRejected
  ).map(result => result.boundary);
  assert.equal(results.filter(result => ['same-tab-reload', 'tab-close', 'cold-browser-restart', 'outbox-storage-failure'].includes(result.boundary)).length, 4);
  assert.deepEqual(violations, [], `Native engine is not a durable-save acknowledgement: ${violations.join(', ')}`);
});

test('actual unavailable-broker connection reports failure without consuming pending outbox', { timeout: 60000 }, async () => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const before = await createDocument(page, 'pending-broker-candidate');
    const connection = await page.evaluate(() => native.connectUnavailableBroker());
    const statuses = Object.values(connection);
    assert.ok(statuses.length > 0);
    assert.ok(statuses.every(status => typeof status.error === 'string' && status.error.length > 0));
    const afterFailure = await page.evaluate(() => native.snapshot());
    assert.equal(afterFailure.outboxDigest, before.outboxDigest);
    assert.equal(afterFailure.outboxEntries, before.outboxEntries);
    assert.equal(afterFailure.document.record, 'pending-broker-candidate');
    results.push({ boundary: 'pre-handshake-connection-failure', errors: statuses.map(status => status.error), before, after: afterFailure, brokerDeliveryTested: false });
  } finally { await context.close(); }
});
