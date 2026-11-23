import { expect } from 'chai';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { NextGraphJournal, mergeJournalRecords } from '../../build/nextgraph-journal.js';
import { documentRevision, documentHeads } from '../../build/document-ledger.js';
import { encodeRecord } from '../../build/onedrive-format.js';

const record = async (text, parents = []) => documentRevision('/notes/a', parents, JSON.parse(await encodeRecord(text, 'text/plain')));
const load = journal => journal.transact([], records => ({ value: records }), false);

describe('Nextgraph append-only recovery journal (IndexedDB API)', function () {
  let original;
  beforeEach(function () { original = globalThis.indexedDB; globalThis.indexedDB = new IDBFactory(); });
  afterEach(function () { globalThis.indexedDB = original; });

  it('persists immutable history and collection identity under actual store and collection namespaces', async function () {
    const a = new NextGraphJournal('private-a', 'collection-a');
    const first = await record('first');
    const second = await record('second', [first]);
    const tombstone = documentRevision('/notes/a', [second]);
    await a.transact([], () => ({ value: undefined, append: [first, second, tombstone] }));
    expect((await load(new NextGraphJournal('private-a', 'collection-a'))).records).to.have.deep.members([first, second, tombstone]);
    expect(await NextGraphJournal.collections('private-a')).to.deep.equal(['collection-a']);
    expect((await load(new NextGraphJournal('private-b', 'collection-a'))).records).to.deep.equal([]);
    expect((await load(new NextGraphJournal('private-a', 'collection-b'))).records).to.deep.equal([]);
  });

  it('keeps concurrent edit/delete heads and all superseded versions', async function () {
    const journal = new NextGraphJournal('private', 'collection');
    const first = await record('first');
    const left = await record('left', [first]);
    const deleted = documentRevision('/notes/a', [first]);
    await journal.transact([first, left, deleted], () => ({ value: undefined }));
    const restored = await load(journal);
    expect(restored.records).to.have.length(3);
    expect(documentHeads(restored.records, '/notes/a').map(item => item.id).sort()).to.deep.equal([left.id, deleted.id].sort());
  });

  it('serializes local precondition checking and append across independent adapters', async function () {
    const one = new NextGraphJournal('private', 'collection');
    const two = new NextGraphJournal('private', 'collection');
    const left = await record('left');
    const right = await record('right');
    const create = (journal, candidate) => journal.transact([], records =>
      documentHeads(records, '/notes/a').length ? { value: 412 } : { value: 201, append: [candidate] });
    const results = await Promise.all([create(one, left), create(two, right)]);
    expect(results.map(item => item.value).sort()).to.deep.equal([201, 412]);
    expect((await load(one)).records).to.have.length(1);
  });

  it('rejects duplicate-ID content differences before adding any native-observed records', async function () {
    const journal = new NextGraphJournal('private', 'collection');
    const first = await record('first');
    await journal.transact([first], () => ({ value: undefined }));
    const another = { ...await record('another'), path: '/notes/b' };
    const incompatible = { ...first, created: first.created + 1 };
    let error;
    try { await journal.transact([another, incompatible], () => ({ value: undefined })); } catch (value) { error = value; }
    expect(error.message).to.include('mismatched');
    expect((await load(journal)).records).to.deep.equal([first]);
  });

  it('compares unknown JSON fields canonically and preserves them', async function () {
    const first = { ...await record('first'), unknown: { right: 2, left: 1 } };
    const reordered = { unknown: { left: 1, right: 2 }, ...first };
    reordered.unknown = { left: 1, right: 2 };
    expect(mergeJournalRecords([first], [reordered])).to.have.length(1);
    expect(() => mergeJournalRecords([first], [{ ...first, unknown: { right: 3, left: 1 } }])).to.throw('mismatched');
  });

  it('aborts invalid history and invalid byte envelopes without poisoning the valid archive', async function () {
    const journal = new NextGraphJournal('private', 'collection');
    const first = await record('first');
    await journal.transact([first], () => ({ value: undefined }));
    for (const bad of [{ ...first, id: 'cycle', parents: ['cycle'] }, { ...first, id: 'bad-bytes', file: { version: 1, contentType: 'text/plain', data: '!' } }]) {
      let rejected = false;
      try { await journal.transact([bad], () => ({ value: undefined })); } catch { rejected = true; }
      expect(rejected).to.equal(true);
      expect((await load(journal)).records).to.deep.equal([first]);
    }
  });

  it('rolls back an entire partial batch on a genuine transaction abort', async function () {
    const journal = new NextGraphJournal('private', 'collection');
    const first = await record('first');
    await journal.transact([first], () => ({ value: undefined }));
    const left = { ...await record('left'), path: '/notes/b' };
    const right = { ...await record('right'), path: '/notes/c' };
    const add = IDBObjectStore.prototype.add;
    let attempted = 0;
    IDBObjectStore.prototype.add = function (...args) {
      if (++attempted === 2) { throw new DOMException('Injected quota failure', 'QuotaExceededError'); }
      return add.apply(this, args);
    };
    let error;
    try { await journal.transact([left, right], () => ({ value: undefined })); } catch (value) { error = value; }
    finally { IDBObjectStore.prototype.add = add; }
    expect(error.name).to.equal('QuotaExceededError');
    expect(attempted).to.equal(2);
    expect((await load(journal)).records).to.deep.equal([first]);
  });

  it('fails without a persistent storage implementation', async function () {
    globalThis.indexedDB = undefined;
    let error;
    try { await NextGraphJournal.collections('private'); } catch (value) { error = value; }
    expect(error.message).to.include('IndexedDB');
  });
});
