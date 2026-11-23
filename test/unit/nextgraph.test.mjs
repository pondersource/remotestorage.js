import { expect } from 'chai';
import { createRequire, registerHooks } from 'node:module';
import { Access } from '../../build/access.js';
import { documentRevision, documentHeads, readLedger } from '../../build/document-ledger.js';
import { encodeRecord } from '../../build/onedrive-format.js';
import { jsonReadbackContract } from '../helpers/json-readback-contract.mjs';

// Replace only the native SDK boundary. These tests do not establish wallet or
// broker interoperability; the production bundle uses the pinned real SDKs.
let sdkLoads = 0;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@ng-org/web' || specifier === '@ng-org/orm') return { url: 'mock:' + specifier, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('mock:@ng-org/')) { sdkLoads++; }
    if (url === 'mock:@ng-org/web') return { format: 'commonjs', shortCircuit: true, source: `
      exports.init = async cb => cb({status:'loggedin',session:{session_id:'session',private_store_id:'private'}});
      exports.ng = {sparql_query:async()=>globalThis.ngFixture.query(), doc_create:async()=>{globalThis.ngFixture.created++;return globalThis.ngFixture.collection;},sparql_update:async()=>{}};` };
    if (url === 'mock:@ng-org/orm') return { format: 'commonjs', shortCircuit: true, source: `
      exports.initNg=()=>{};
      exports.DiscreteOrmSubscription={getOrCreate:()=>globalThis.ngFixture.subscription};` };
    return next(url, context);
  }
});
const NextGraph = createRequire(import.meta.url)('../../build/nextgraph.js');
// Native SDK requires are deferred until connect; keep boundary hooks alive.
after(() => hooks.deregister());
function fixture() {
  globalThis.ngFixture?.backend?.configure({ token: null });
  const documents = {}, events = [];
  const f = { collection: 'did:ng:collection-' + crypto.randomUUID(), documents, commits: 0, closed: 0, created: 0,
    query: () => ({ results: { bindings: [{ id: { value: f.collection } }] } }) };
  f.subscription = { readyPromise: Promise.resolve(documents), beginTransaction() {},
    async commitTransaction() { f.commits++; if (f.failCommit) throw Error('Local storage failed'); }, close() { f.closed++; } };
  globalThis.ngFixture = f;
  const rs = { remote: { connected: false }, local: {}, access: new Access(),
    setBackend(backend) { this.backend = backend; }, _fireReady() {}, _emit(...args) { events.push(args); } };
  rs.access.claim('notes', 'rw');
  f.rs = rs; f.events = events; f.backend = new NextGraph(rs); return f;
}
const envelope = async text => JSON.parse(await encodeRecord(text, 'text/plain'));
function add(f, record) { f.documents['rs_revision_' + record.id] = JSON.stringify(record); }

describe('Nextgraph document ledger (native SDK boundary mocked)', function() {
  it('does not evaluate native SDK modules when loading or constructing the backend', function() {
    const f = fixture();
    expect(f.backend.connected).to.equal(false);
    expect(sdkLoads).to.equal(0);
  });
  it('opens the private collection and writes through an awaited native transaction', async function() {
    const f = fixture(); await f.backend.connect();
    const created = await f.backend.put('/notes/a', 'hello', 'text/plain', {ifNoneMatch:'*'});
    expect(created.statusCode).to.equal(201); expect(f.commits).to.equal(1);
    expect(f.rs.remote).to.equal(f.backend); expect(f.backend.deliveryState).to.equal('local');
    expect(await f.backend.get('/notes/a')).to.include({statusCode:200,body:'hello',revision:created.revision});
    expect((await f.backend.put('/notes/a','collision','text/plain',{ifNoneMatch:'*'})).statusCode).to.equal(412);
    expect((await f.backend.put('/notes/a','stale','text/plain',{ifMatch:'stale'})).statusCode).to.equal(412);
  });
  it('preserves JSON text through real Sync revalidation of an acknowledged write', async function() {
    const f = fixture(); await f.backend.connect();
    const acknowledged = '{ "title": "first", "unknown": [1, 2] }\n';
    await f.backend.put('/notes/record.json', acknowledged, 'application/json');
    await jsonReadbackContract(await f.backend.get('/notes/record.json'), acknowledged, '{"title":"pending"}');
  });
  it('retains concurrent edits and edit/delete conflicts until explicit resolution', async function() {
    const f=fixture(); await f.backend.connect();
    const base=documentRevision('/notes/a',[],await envelope('base')); add(f,base);
    const left=documentRevision('/notes/a',[base],await envelope('left'));
    const right=documentRevision('/notes/a',[base]); add(f,left);add(f,right);
    expect((await f.backend.get('/notes/a')).statusCode).to.equal(409);
    expect((await f.backend.put('/notes/a','overwrite','text/plain')).statusCode).to.equal(409);
    expect(f.backend.deliveryState).to.equal('needs-attention');
    expect(f.backend.getConflicts('/notes/a')).to.have.length(2);
    await f.backend.resolveConflict('/notes/a',left.id);
    expect((await f.backend.get('/notes/a')).body).to.equal('left');
    expect(readLedger(f.documents)).to.have.length(4);
  });
  it('retains tombstones and rejects stale writes after deletion', async function() {
    const f=fixture();await f.backend.connect();
    const first=await f.backend.put('/notes/a','first','text/plain');
    expect((await f.backend.delete('/notes/a',{ifMatch:first.revision})).statusCode).to.equal(204);
    expect((await f.backend.get('/notes/a')).statusCode).to.equal(404);
    expect((await f.backend.put('/notes/a','old','text/plain',{ifMatch:first.revision})).statusCode).to.equal(412);
    expect(readLedger(f.documents)).to.have.length(2);
  });
  it('aggregates every descendant revision in a stable directory validator', async function() {
    const f=fixture();await f.backend.connect();
    const a=await f.backend.put('/notes/folder/a','a','text/plain');
    const b=await f.backend.put('/notes/folder/b','b','text/plain');
    const listing=await f.backend.get('/notes/');
    expect(listing.body.items['folder/'].ETag).to.equal([a.revision,b.revision].sort().join(','));
    await f.backend.put('/notes/folder/a','new','text/plain');
    expect((await f.backend.get('/notes/')).body.items['folder/'].ETag).not.to.equal(listing.body.items['folder/'].ETag);
  });
  it('validates a whole import before writing, preserves exact bytes, and refuses overwrites', async function() {
    const f=fixture();await f.backend.connect();
    const file=JSON.parse(await encodeRecord('{ "unknown": [1, 2] }\n','application/json'));
    const snapshot={format:'pondersource-rs-documents',version:1,records:[{path:'/notes/a',file}]};
    expect(await f.backend.importSnapshot(snapshot)).to.deep.equal([{path:'/notes/a',statusCode:201}]);
    expect(documentHeads(readLedger(f.documents),'/notes/a')[0].file).to.deep.equal(file);
    expect(await f.backend.importSnapshot(snapshot)).to.deep.equal([{path:'/notes/a',statusCode:412}]);
    let failed=false;
    try { await f.backend.importSnapshot({...snapshot,records:[{path:'/notes/new',file},{path:'/private/a',file}]}); } catch {failed=true;}
    expect(failed).to.equal(true);expect(f.commits).to.equal(1);
  });
  it('exports guest cache scopes without fetching remote data or deleting the source', async function() {
    const f=fixture(); const calls=[];
    f.rs.local.get=async path=>{calls.push(path);return path.endsWith('/')?{statusCode:200,body:path.replace('/public','')==='/notes/'?{'a':{},'nested/':{}}:{b:{}}}:{statusCode:200,body:'original',contentType:'text/turtle'};};
    const snapshot=await f.backend.exportSnapshot();
    expect(snapshot.records.map(r=>r.path)).to.deep.equal(['/notes/a','/notes/nested/b','/public/notes/a','/public/notes/nested/b']);
    expect(calls.every(path=>path.startsWith('/notes/')||path.startsWith('/public/notes/'))).to.equal(true);
    expect(f.commits).to.equal(0);
  });
  it('invalidates a failed SDK view and cancels a delayed payload on disconnect', async function() {
    const f=fixture();await f.backend.connect();f.failCommit=true;
    let error;try{await f.backend.put('/notes/a','hello','text/plain');}catch(e){error=e;}
    expect(error.message).to.equal('Local storage failed');expect(f.backend.connected).to.equal(false);expect(f.closed).to.equal(1);
    expect(f.backend.requiresReload).to.equal(true);
    try{await f.backend.connect();}catch(e){error=e;}
    expect(error.message).to.include('Reload');
    const reopened=new NextGraph({...f.rs,remote:{connected:false}});
    try{await reopened.connect();}catch(e){error=e;}
    expect(error.message).to.include('Reload');expect(reopened.requiresReload).to.equal(true);
    const g=fixture();await g.backend.connect();let release;
    const body=new Blob(['old']);body.arrayBuffer=()=>new Promise(resolve=>{release=resolve;});
    const pending=g.backend.put('/notes/a',body,'text/plain');
    g.backend.configure({userAddress:null,token:null});release(new Uint8Array([1]).buffer);
    try{await pending;}catch(e){error=e;}
    expect(error.message).to.include('cancelled');expect(g.commits).to.equal(0);
  });
  it('rejects overlapping connects and prevents two adapters sharing a mutable SDK transaction', async function() {
    const f=fixture();let release;
    f.query=()=>new Promise(resolve=>{release=resolve;});
    const first=f.backend.connect();await new Promise(resolve=>setImmediate(resolve));
    let error;try{await f.backend.connect();}catch(e){error=e;}
    expect(error.message).to.include('already in progress');
    release({results:{bindings:[{id:{value:f.collection}}]}});await first;
    const rs={...f.rs,remote:{connected:false}};
    const second=new NextGraph(rs);
    f.query=()=>({results:{bindings:[{id:{value:f.collection}}]}});
    try{await second.connect();}catch(e){error=e;}
    expect(error.message).to.include('one remoteStorage instance');
    f.backend.configure({token:null});await second.connect();
    expect(second.connected).to.equal(true);second.configure({token:null});
  });

  it('refuses ambiguous collections and cyclic or unrelated histories', async function() {
    const f=fixture();f.query=()=>({results:{bindings:[{id:{value:'did:ng:one'}},{id:{value:'did:ng:two'}}]}});
    let error;try{await f.backend.connect();}catch(e){error=e;}
    expect(error.message).to.include('Multiple');expect(f.backend.connected).to.equal(false);
    const a=documentRevision('/notes/a',[],await envelope('a'));a.parents=[a.id];
    expect(()=>readLedger({['rs_revision_'+a.id]:JSON.stringify(a)})).to.throw('unrelated');
  });
});
