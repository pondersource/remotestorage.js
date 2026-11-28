import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { Access } from '../../build/access.js';
import Atomic from '../../build/atomic.js';

const core = 'https://atomicdata.dev/properties/';
const node = 'https://node1.atomicserver.eu';
const id = 'atomic:' + 'a'.repeat(86);

function fixture() {
  const revisions = [];
  const requests = [];
  let canRead = true;
  let canWrite = true;
  let isPublic = false;
  let failWrite = false;
  const sdk = {
    Agent: { fromCryptoKeyPair: (keys, subject) => ({
      subject, async getPublicKey() { return Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('base64'); }
    }) },
    agentSubjectFromPublicKey: key => ({ subject: 'did:agent:' + key }),
    connectAgentUrl(site, { publicKey, targets }) {
      const link = new URL('/app/connect-agent', site);
      link.searchParams.set('key', publicKey);
      link.searchParams.set('target', targets[0]);
      return link.href;
    },
    signRequest: async (url, agent, headers) => ({ ...headers, 'x-atomic-agent': agent.subject, 'x-atomic-signature': 'fixture-signature' }),
    server: { classes: { drive: 'atomic-drive' } },
    LoroLoader: { initializeLoro: async () => {} },
    decodeB64: value => value,
    decodeGenesisCert: value => value,
    verifyGenesisCert: async cert => cert === 'genesis',
    genesisSignerDid: () => 'did:owner',
    Client: class {
      constructor(fetch) { this.fetch = fetch; }
      async fetchResourceHTTP(subject, { serverURL }) {
        const request = subject.startsWith('atomic:') ? serverURL + '/resource?subject=' + encodeURIComponent(subject) : subject;
        const response = await this.fetch(request);
        const { properties, classes } = await response.json();
        return { resource: {
          subject, get: name => properties[name], getSubjects: name => properties[name] || [],
          hasClasses: name => classes?.includes(name)
        } };
      }
      async postCommit(commit, target) { return this.fetch(target, { method: 'POST', body: JSON.stringify(commit) }); }
    },
    Store: class {
      constructor(options) { this.options = options; }
      addResource() {}
      async newResource({ parent, propVals }) {
        return { save: async () => (await this.options.commitTransport({ ...propVals, [core + 'parent']: parent })).ok
          ? 'persisted' : 'failed' };
      }
    }
  };
  globalThis.fetch = async (input, init) => {
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    const url = new URL(input);
    assert.equal(url.origin, node);
    requests.push([url.pathname, init.method || 'GET']);
    if (url.pathname === '/commit') {
      if (failWrite) return new Response(null, { status: 503 });
      revisions.push(JSON.parse(init.body));
      return new Response('');
    }
    assert.equal(init.headers['x-atomic-signature'], 'fixture-signature');
    const agent = init.headers['x-atomic-agent'];
    if (url.pathname === '/query') {
      assert.equal(url.searchParams.get('drive'), id);
      assert.deepEqual(JSON.parse(url.searchParams.get('filters')), [{ property: core + 'name', value: 'Ponder Source documents v1 app.example' }]);
      return Response.json({ properties: {
        [core + 'collection/members']: revisions.map((_, offset) => 'atomic:' + String(offset).padStart(86, '0')),
        [core + 'collection/totalMembers']: revisions.length
      } });
    }
    const subject = url.searchParams.get('subject');
    if (subject !== id) return Response.json({ properties: revisions[Number(subject.slice('atomic:'.length))] });
    return Response.json({ classes: ['atomic-drive'], properties: {
      [core + 'genesis']: 'genesis', [core + 'createdBy']: 'did:owner',
      [core + 'read']: [...(canRead ? [agent] : []), ...(isPublic ? ['https://atomicdata.dev/agents/publicAgent'] : [])],
      [core + 'write']: canWrite ? [agent] : []
    } });
  };
  Atomic.loadSDK = async () => sdk;
  const events = new Map();
  const rs = { remote: { connected: false }, local: {}, access: new Access(), handlers: events,
    setBackend(backend) { this.backend = backend; }, _fireReady() {},
    on(name, handler) { events.set(name, handler); },
    removeEventListener(name) { events.delete(name); },
    _emit(name, error) { if (name === 'error') throw error; } };
  rs.access.claim('notes', 'rw');
  Atomic._rs_init(rs);
  return { rs, requests, revisions,
    makePublic() { isPublic = true; }, revokeWrite() { canWrite = false; }, failWrite() { failWrite = true; } };
}

describe('Atomic app-key storage backend', () => {
  let old;
  beforeEach(() => {
    old = { fetch: globalThis.fetch, indexedDB: globalThis.indexedDB, window: globalThis.window };
    globalThis.indexedDB = new IDBFactory();
    globalThis.window = { location: { host: 'app.example' } };
  });
  afterEach(() => { Object.assign(globalThis, old); Atomic.loadSDK = undefined; });

  it('uses the selected drive and app public key, persists writes and restores the same key after reload', async () => {
    const { rs, requests, revisions } = fixture();
    const selected = await rs.atomic.requestAppKey('https://atomic.place', { drive: id, signal: new AbortController().signal });
    const link = new URL(selected.grantUrl);
    assert.equal(link.href.startsWith('https://app.atomic.place/app/connect-agent?'), true);
    assert.equal(link.searchParams.get('target'), id);
    assert.equal(Buffer.from(link.searchParams.get('key'), 'base64').length, 32);
    assert.equal(rs.remote.connected, false);
    await selected.waitForGrant();
    const dbRequest = indexedDB.open('remotestorage-atomic-v1', 1);
    const record = await new Promise(resolve => {
      dbRequest.onsuccess = () => {
        const db = dbRequest.result;
        const read = db.transaction('atomic').objectStore('atomic').get('connection');
        read.onsuccess = () => { db.close(); resolve(read.result); };
      };
    });
    assert.equal(record.keyPair.privateKey.extractable, false);
    const created = await rs.remote.put('/notes/example', 'one', 'text/plain', { ifNoneMatch: '*' });
    assert.equal(created.statusCode, 201);
    assert.equal((await rs.remote.get('/notes/example')).body, 'one');
    assert.equal((await rs.remote.get('/notes/')).body.items.example.ETag, created.revision);
    assert.equal((await rs.remote.put('/notes/example', 'wrong revision', 'text/plain', { ifMatch: 'other' })).statusCode, 412);
    assert.equal(revisions.length, 1);

    rs.remote = { connected: false };
    Atomic._rs_init(rs);
    await rs.handlers.get('features-loaded')();
    assert.equal((await rs.remote.get('/notes/example')).body, 'one');
    await rs.remote.delete('/notes/example', { ifMatch: created.revision });
    assert.equal((await rs.remote.get('/notes/example')).statusCode, 404);
    assert.equal(requests.filter(([path]) => path === '/commit').length, 2);
    await Atomic._rs_cleanup(rs);

    rs.remote = { connected: false };
    rs.backend = 'atomic';
    Atomic._rs_init(rs);
    await rs.handlers.get('features-loaded')();
    assert.equal(rs.remote.connected, false);
  });

  it('stops an unapproved, cancelled key and continues to enforce revoked grants', async () => {
    const { rs, revokeWrite } = fixture();
    const pending = new AbortController();
    const cancelled = await rs.atomic.requestAppKey('https://atomic.place', { drive: id, signal: pending.signal });
    pending.abort();
    await assert.rejects(cancelled.waitForGrant(), { name: 'AbortError' });
    const selected = await rs.atomic.requestAppKey('https://atomic.place', { drive: id, signal: new AbortController().signal });
    await selected.waitForGrant();
    revokeWrite();
    await assert.rejects(rs.remote.put('/notes/example', 'value', 'text/plain'), /Approve Read and edit/);
  });

  it('does not put private documents in a publicly readable drive', async () => {
    const { rs, makePublic } = fixture();
    makePublic();
    const selected = await rs.atomic.requestAppKey('https://atomic.place', { drive: id, signal: new AbortController().signal });
    await assert.rejects(selected.waitForGrant(), /Choose a private Atomic drive/);
    assert.equal(rs.remote.connected, false);
  });

  it('reports conflicts and a failed online acknowledgement without claiming a successful write', async () => {
    const { rs, revisions, failWrite } = fixture();
    const selected = await rs.atomic.requestAppKey('https://atomic.place', { drive: id, signal: new AbortController().signal });
    await selected.waitForGrant();
    await assert.rejects(rs.remote.put('/other/example', 'value', 'text/plain'), /no access/);
    await assert.rejects(rs.remote.put('/public/notes/example', 'value', 'text/plain'), /Public sharing/);
    await rs.remote.put('/notes/example', 'left', 'text/plain');
    const data = { ...JSON.parse(revisions[0][core + 'description']), id: 'right' };
    revisions.push({ ...revisions[0], [core + 'shortname']: data.id, [core + 'description']: JSON.stringify(data) });
    assert.equal((await rs.remote.get('/notes/example')).statusCode, 409);
    assert.equal((await rs.remote.put('/notes/example', 'right', 'text/plain')).statusCode, 409);
    failWrite();
    await assert.rejects(rs.remote.put('/notes/other', 'failed', 'text/plain'), /did not confirm/);
  });
});
