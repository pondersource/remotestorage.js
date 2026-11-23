import "mocha";
import { expect } from "chai";
import IndexedDB from "../../build/indexeddb.js";
import LocalStorage from "../../build/localstorage.js";
import { withCacheTransaction } from "../../build/cache-transaction.js";

function manualDatabase() {
  const rows = new Map();
  const transactions = [];
  const database = {
    name: "durability-test",
    transaction() {
      const operations = [];
      const transaction = {
        error: null,
        objectStore() {
          return {
            put(node) {
              if (database.putError) { throw database.putError; }
              operations.push(() => rows.set(node.path, structuredClone(node)));
            },
            delete(path) { operations.push(() => rows.delete(path)); }
          };
        },
        commit() {
          for (const operation of operations) { operation(); }
          transaction.oncomplete();
        },
        abort() {
          transaction.abortRequested = true;
          if (!database.holdAbort) { queueMicrotask(() => transaction.onabort()); }
        }
      };
      transactions.push(transaction);
      return transaction;
    }
  };
  const cache = new IndexedDB(database);
  cache.getNodesFromDb = async paths => Object.fromEntries(paths.map(path => [path, structuredClone(rows.get(path))]));
  return { cache, database, rows, transactions };
}

const node = body => ({ path: "/notes/a", common: { body, contentType: "text/plain" } });
const microtasks = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); } };

describe("cache durability", () => {
  it("settles only after the transaction completes while keeping its pending row visible", async () => {
    const { cache, transactions } = manualDatabase();
    let settled = false;
    const written = cache.setNodes({ "/notes/a": node("pending") }).then(() => { settled = true; });
    try {
      await microtasks();
      expect(settled).to.equal(false);
      expect((await cache.getNodes(["/notes/a"]))["/notes/a"].common.body).to.equal("pending");
    } finally { transactions[0].commit(); }
    await written;
    expect(settled).to.equal(true);
  });

  it("exposes a later external commit instead of retaining the previous committed overlay", async () => {
    const { cache, rows, transactions } = manualDatabase();
    const written = cache.setNodes({ "/notes/a": node("first") });
    transactions[0].commit();
    await written;
    rows.set("/notes/a", node("written by another tab"));
    expect((await cache.getNodes(["/notes/a"]))["/notes/a"].common.body).to.equal("written by another tab");
  });

  it("settles each queued batch after its own commit and preserves the newer visible row", async () => {
    const { cache, transactions } = manualDatabase();
    const first = cache.setNodes({ "/notes/a": node("first") });
    let secondSettled = false;
    const second = cache.setNodes({ "/notes/a": node("second") }).then(() => { secondSettled = true; });
    expect((await cache.getNodes(["/notes/a"]))["/notes/a"].common.body).to.equal("second");
    transactions[0].commit();
    await first;
    await microtasks();
    try {
      expect(secondSettled).to.equal(false);
      expect((await cache.getNodes(["/notes/a"]))["/notes/a"].common.body).to.equal("second");
    } finally { transactions[1].commit(); }
    await second;
    expect(secondSettled).to.equal(true);
  });

  for (const event of ["onabort", "onerror"]) {
    it("rejects the failed batch on " + event + " without erasing a queued successor", async () => {
      const { cache, rows, transactions } = manualDatabase();
      rows.set("/notes/a", node("committed"));
      const failed = cache.setNodes({ "/notes/a": node("aborted") }).then(() => undefined, error => error);
      const successor = cache.setNodes({ "/notes/a": node("successor") });
      transactions[0][event]();
      expect(await failed).to.be.instanceOf(Error);
      await microtasks();
      if (event === "onerror") { transactions[0].onabort(); }
      expect(cache.putsRunning).to.equal(1);
      expect((await cache.getNodes(["/notes/a"]))["/notes/a"].common.body).to.equal("successor");
      transactions[1].commit();
      await successor;
      expect(cache.putsRunning).to.equal(0);
      expect((await cache.getNodes(["/notes/a"]))["/notes/a"].common.body).to.equal("successor");
    });
  }

  it("counts a transaction that emits both error and abort only once", async () => {
    const { cache, transactions } = manualDatabase();
    const failed = cache.setNodes({ "/notes/a": node("aborted") }).catch(error => error);
    transactions[0].onerror();
    transactions[0].onabort();
    expect(await failed).to.be.instanceOf(Error);
    expect(cache.putsRunning).to.equal(0);
    expect(cache.changesRunning).to.deep.equal({});
  });

  for (const synchronous of [false, true]) {
    it("waits for abort completion after " + (synchronous ? "a synchronous put failure" : "a request error"), async () => {
      const { cache, database, transactions } = manualDatabase();
      const original = new Error("original write failure");
      database.holdAbort = true;
      if (synchronous) { database.putError = original; }
      let settled = false;
      const failed = cache.setNodes({ "/notes/a": node("aborted") }).then(
        () => { settled = true; }, error => { settled = true; return error; }
      );
      const transaction = transactions[0];
      if (!synchronous) {
        transaction.onerror({ target: { error: original }, preventDefault() {} });
      }
      try {
        await microtasks();
        expect(transaction.abortRequested).to.equal(true);
        expect(settled).to.equal(false);
        expect(cache.putsRunning).to.equal(1);
        expect(cache.changesRunning).to.have.property("/notes/a");
      } finally { transaction.onabort(); }
      expect(await failed).to.equal(original);
      expect(cache.putsRunning).to.equal(0);
      expect(cache.changesRunning).to.deep.equal({});
    });
  }

  it("rejects a synchronous put failure and leaves the cache able to commit another batch", async () => {
    const { cache, database, transactions } = manualDatabase();
    database.putError = new Error("could not clone the row");
    const failure = await cache.setNodes({ "/notes/a": node("invalid") }).catch(error => error);
    expect(failure.message).to.equal("could not clone the row");
    expect(cache.putsRunning).to.equal(0);
    expect(cache.changesRunning).to.deep.equal({});
    delete database.putError;
    const written = cache.setNodes({ "/notes/a": node("valid") });
    transactions[1].commit();
    await written;
    expect((await cache.getNodes(["/notes/a"]))["/notes/a"].common.body).to.equal("valid");
  });

  it("gives persistent adapters stable, store-specific identities", () => {
    const a = new IndexedDB({ name: "one" });
    const b = new IndexedDB({ name: "one" });
    const c = new IndexedDB({ name: "two" });
    expect(a.sharedCacheId).to.equal(b.sharedCacheId);
    expect(a.sharedCacheId).to.not.equal(c.sharedCacheId);
    expect(a.sharedCacheId).to.include("nodes");
    expect(new LocalStorage().sharedCacheId).to.not.equal(a.sharedCacheId);
  });

  it("keeps isolated cache transactions usable without browser locks, including after rejection", async () => {
    const cache = {};
    const events = [];
    const failed = withCacheTransaction(cache, async () => { events.push("first"); throw new Error("failed"); }).catch(error => error);
    const next = withCacheTransaction(cache, async () => { events.push("second"); return "done"; });
    expect(await failed).to.be.instanceOf(Error);
    expect(await next).to.equal("done");
    expect(events).to.deep.equal(["first", "second"]);
  });

  it("keeps the per-adapter queue when persistent storage has no Web Locks", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: undefined });
    try {
      const cache = { sharedCacheId: "persistent-without-locks" };
      let release;
      let nextStarted = false;
      const first = withCacheTransaction(cache, () => new Promise(resolve => { release = resolve; }));
      const second = withCacheTransaction(cache, async () => { nextStarted = true; });
      await microtasks();
      expect(nextStarted).to.equal(false);
      release();
      await Promise.all([first, second]);
      expect(nextStarted).to.equal(true);
    } finally {
      if (original) { Object.defineProperty(globalThis, "navigator", original); }
      else { delete globalThis.navigator; }
    }
  });
});
