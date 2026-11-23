const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { createServer } = require('node:http');
const { mkdtemp, writeFile, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const webpack = require('webpack');
const { chromium } = require('@playwright/test');

let browser, server, directory, address;
before(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'rs-cache-durability-'));
  const source = name => JSON.stringify(path.resolve(__dirname, '../src/' + name));
  const entry = path.join(directory, 'entry.js');
  await writeFile(entry, `module.exports={IndexedDB:require(${source('indexeddb.ts')}),transaction:require(${source('cache-transaction.ts')}).withCacheTransaction};`);
  await new Promise((resolve, reject) => {
    const compiler = webpack({
      mode: 'development', devtool: false, entry,
      output: { path: directory, filename: 'fixture.js', library: { name: 'CacheFixture', type: 'var' } },
      resolve: { extensions: ['.ts', '.js', '.json'] },
      module: { rules: [{ test: /\.ts$/, use: { loader: require.resolve('ts-loader'), options: { transpileOnly: true } } }] }
    });
    compiler.run((error, stats) => compiler.close(() => {
      if (error || stats.hasErrors()) reject(error || new Error(stats.toString({ all: false, errors: true })));
      else resolve();
    }));
  });
  const bundle = await readFile(path.join(directory, 'fixture.js'));
  server = createServer((request, response) => {
    if (request.url === '/fixture.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(bundle); return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><script src="/fixture.js"></script><script>
      window.openCache=async (name,constrained)=>{
        const db=await new Promise((resolve,reject)=>{
          const request=indexedDB.open(name,2);
          request.onupgradeneeded=()=>{
            const nodes=request.result.createObjectStore('nodes',{keyPath:'path'});
            if(constrained)nodes.createIndex('unique-label','label',{unique:true});
            request.result.createObjectStore('changes',{keyPath:'path'});
          };
          request.onsuccess=()=>resolve(request.result);
          request.onerror=()=>reject(request.error);
        });
        window.cache=new CacheFixture.IndexedDB(db);
        return cache.sharedCacheId;
      };
      window.row=body=>({path:'/notes/a',common:{body,contentType:'text/plain'}});
    </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  address = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function pageWithCache(context, name, constrained = false) {
  const page = await context.newPage();
  await page.goto(address);
  await page.evaluate(({ name, constrained }) => openCache(name, constrained), { name, constrained });
  return page;
}

test('real IndexedDB writes resolve after commit and aborts reject without a phantom row', async () => {
  const context = await browser.newContext();
  try {
    const page = await pageWithCache(context, 'durability-' + crypto.randomUUID());
    const result = await page.evaluate(async () => {
      const transaction = cache.db.transaction.bind(cache.db);
      let committed = false;
      cache.db.transaction = (...args) => {
        const tx = transaction(...args);
        if (args[1] === 'readwrite') tx.addEventListener('complete', () => { committed = true; });
        return tx;
      };
      await cache.setNodes({ '/notes/a': row('committed') });
      const committedWhenResolved = committed;

      cache.db.transaction = (...args) => {
        const tx = transaction(...args);
        if (args[1] === 'readwrite') {
          const objectStore = tx.objectStore.bind(tx);
          tx.objectStore = name => {
            const store = objectStore(name), put = store.put.bind(store);
            store.put = value => { const request = put(value); tx.abort(); return request; };
            return store;
          };
        }
        return tx;
      };
      const failed = await cache.setNodes({ '/notes/a': row('must abort') }).then(
        () => ({ rejected: false }), error => ({ rejected: true, message: String(error) })
      );
      const visible = (await cache.getNodes(['/notes/a']))['/notes/a'];
      return { committedWhenResolved, failed, visible: visible.common.body, running: cache.putsRunning };
    });
    assert.equal(result.committedWhenResolved, true);
    assert.equal(result.failed.rejected, true);
    assert.equal(result.visible, 'committed');
    assert.equal(result.running, 0);
  } finally { await context.close(); }
});

test('a real DataCloneError rolls back the partial batch before releasing its cache lock', async () => {
  const context = await browser.newContext();
  try {
    const page = await pageWithCache(context, 'clone-failure-' + crypto.randomUUID());
    const result = await page.evaluate(async () => {
      await cache.setNodes({ '/notes/a': row('before') });
      const transaction = cache.db.transaction.bind(cache.db);
      let aborted = false;
      cache.db.transaction = (...args) => {
        const tx = transaction(...args);
        if (args[1] === 'readwrite') tx.addEventListener('abort', () => { aborted = true; });
        return tx;
      };
      const failed = await CacheFixture.transaction(cache, () => cache.setNodes({
        '/notes/a': row('must roll back'),
        '/notes/invalid': { ...row('invalid'), path: '/notes/invalid', uncloneable() {} }
      })).then(() => ({ rejected: false }), error => ({ rejected: true, message: String(error), abortedWhenRejected: aborted }));
      const nodes = await cache.getNodes(['/notes/a', '/notes/invalid']);
      return { failed, visible: nodes['/notes/a'].common.body, invalidExists: !!nodes['/notes/invalid'], running: cache.putsRunning };
    });
    assert.equal(result.failed.rejected, true);
    assert.match(result.failed.message, /DataCloneError/);
    assert.equal(result.failed.abortedWhenRejected, true);
    assert.equal(result.visible, 'before');
    assert.equal(result.invalidExists, false);
    assert.equal(result.running, 0);
  } finally { await context.close(); }
});

test('a canceled request error still aborts the whole real IndexedDB batch', async () => {
  const context = await browser.newContext();
  try {
    const page = await pageWithCache(context, 'constraint-failure-' + crypto.randomUUID(), true);
    const result = await page.evaluate(async () => {
      await cache.setNodes({
        '/notes/a': { ...row('before'), label: 'one' },
        '/notes/protected': { ...row('protected'), path: '/notes/protected', label: 'taken' }
      });
      const transaction = cache.db.transaction.bind(cache.db);
      let aborted = false, prevented = false;
      cache.db.transaction = (...args) => {
        const tx = transaction(...args);
        if (args[1] === 'readwrite') {
          tx.addEventListener('abort', () => { aborted = true; });
          const objectStore = tx.objectStore.bind(tx);
          tx.objectStore = name => {
            const store = objectStore(name), put = store.put.bind(store);
            store.put = value => {
              const request = put(value);
              request.addEventListener('error', event => { prevented = true; event.preventDefault(); });
              return request;
            };
            return store;
          };
        }
        return tx;
      };
      const failed = await CacheFixture.transaction(cache, () => cache.setNodes({
        '/notes/a': { ...row('must roll back'), label: 'one' },
        '/notes/invalid': { ...row('invalid'), path: '/notes/invalid', label: 'taken' }
      })).then(() => ({ rejected: false }), error => ({ rejected: true, message: String(error), abortedWhenRejected: aborted }));
      const nodes = await cache.getNodes(['/notes/a', '/notes/invalid']);
      return { failed, prevented, visible: nodes['/notes/a'].common.body, invalidExists: !!nodes['/notes/invalid'], running: cache.putsRunning };
    });
    assert.equal(result.prevented, true);
    assert.equal(result.failed.rejected, true);
    assert.equal(result.visible, 'before', JSON.stringify(result));
    assert.match(result.failed.message, /ConstraintError/);
    assert.equal(result.failed.abortedWhenRejected, true);
    assert.equal(result.invalidExists, false);
    assert.equal(result.running, 0);
  } finally { await context.close(); }
});

test('a committed row from another tab is visible through an existing cache adapter', async () => {
  const context = await browser.newContext();
  try {
    const name = 'visibility-' + crypto.randomUUID();
    const first = await pageWithCache(context, name), second = await pageWithCache(context, name);
    await first.evaluate(() => cache.setNodes({ '/notes/a': row('first tab') }));
    await second.evaluate(() => cache.setNodes({ '/notes/a': row('second tab') }));
    assert.equal(await first.evaluate(async () => (await cache.getNodes(['/notes/a']))['/notes/a'].common.body), 'second tab');
  } finally { await context.close(); }
});

test('separate adapters share a short cache lock through the durable read-modify-write', async () => {
  const context = await browser.newContext();
  let firstWork, secondWork;
  let first;
  try {
    const name = 'locks-' + crypto.randomUUID();
    first = await pageWithCache(context, name);
    const second = await pageWithCache(context, name);
    await first.evaluate(() => cache.setNodes({ '/notes/a': row('0') }));
    firstWork = first.evaluate(() => CacheFixture.transaction(cache, async () => {
      const current = (await cache.getNodes(['/notes/a']))['/notes/a'];
      window.entered = true;
      await new Promise(resolve => { window.release = resolve; });
      await cache.setNodes({ '/notes/a': row(String(Number(current.common.body) + 1)) });
    }));
    await first.waitForFunction(() => window.entered);
    secondWork = second.evaluate(() => {
      window.started = true;
      return CacheFixture.transaction(cache, async () => {
        window.entered = true;
        const current = (await cache.getNodes(['/notes/a']))['/notes/a'];
        await cache.setNodes({ '/notes/a': row(String(Number(current.common.body) + 1)) });
      });
    });
    await second.waitForFunction(() => window.started);
    const state = await second.evaluate(async () => ({ locks: await navigator.locks.query(), entered: !!window.entered, identity: cache.sharedCacheId }));
    const lockName = 'remotestorage:cache:' + state.identity;
    assert.equal(state.entered, false);
    assert.equal(state.locks.held.filter(lock => lock.name === lockName).length, 1);
    assert.equal(state.locks.pending.filter(lock => lock.name === lockName).length, 1);
    await first.evaluate(() => window.release());
    await Promise.all([firstWork, secondWork]);
    assert.equal(await first.evaluate(async () => (await cache.getNodes(['/notes/a']))['/notes/a'].common.body), '2');
  } finally {
    if (first) await first.evaluate(() => window.release?.()).catch(() => {});
    await Promise.allSettled([firstWork, secondWork]);
    await context.close();
  }
});
