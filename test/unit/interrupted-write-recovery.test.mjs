import assert from 'node:assert/strict';
import { expect } from 'chai';
import InMemoryStorage from '../../build/inmemorystorage.js';
import { Sync } from '../../build/sync.js';
import WireClient from '../../build/wireclient.js';

const path = '/notes/a', type = 'text/plain';
function fixture() {
  const events = [], calls = [];
  const remote = { userAddress: 'same-account', href: 'https://example.test/storage-a/', storageApi: 'draft-dejong-remotestorage-22',
    supportsRevs: true, supportsAtomicCreate: true, getStorageIdentity: WireClient.prototype.getStorageIdentity,
    async get() { calls.push('get'); return { statusCode: 200 }; }, async put() { calls.push('put'); return { statusCode: 200 }; } };
  const rs = { local: new InMemoryStorage(), remote, backend: 'remotestorage', access: { checkPathPermission: () => true },
    caching: { onActivate() {}, checkPath() { return 'ALL'; } }, _emit: (...args) => events.push(args) };
  rs.sync = new Sync(rs); rs.sync.stopped = true; rs.sync.doTasks = () => true;
  const operation = (id = 'current', base = { body: 'base', contentType: type, revision: 'base-revision' }) =>
    ({ version: 1, id, base, destination: rs.sync.destination(), owned: true, state: 'pending' });
  return { rs, events, calls, operation };
}

describe('interrupted write candidate lifecycle', function() {
  it('ignores late success and failure belonging to a replaced operation', async function() {
    const { rs, operation, events } = fixture();
    const node = { path, common: { body: 'base', contentType: type, revision: 'base-revision' },
      local: { body: 'latest local', contentType: type }, push: { body: 'new operation', contentType: type, operation: operation('new') } };
    await rs.local.setNodes({ [path]: node });
    await rs.sync.handleResponse(path, 'put', { statusCode: 201, revision: 'old-ack' }, 'old');
    await rs.sync.handleResponse(path, 'put', { statusCode: 500 }, 'old');
    expect((await rs.local.getNodes([path]))[path]).to.deep.equal(node);
    expect(events).to.deep.equal([]);
  });

  it('acknowledges only its snapshot while preserving a newer local edit', async function() {
    const { rs, operation } = fixture();
    await rs.local.setNodes({ [path]: { path, common: { body: 'base', contentType: type },
      local: { body: 'newer', contentType: type }, push: { body: 'sent', contentType: type, operation: operation() } } });
    await rs.sync.handleResponse(path, 'put', { statusCode: 204, revision: 'sent-revision' }, 'current');
    const node = (await rs.local.getNodes([path]))[path];
    expect(node.common).to.include({ body: 'sent', revision: 'sent-revision' });
    expect(node.local.body).to.equal('newer'); expect(node.push).to.equal(undefined);
  });

  it('defers remote adoption while retaining a pending candidate with no local copy', async function() {
    const { rs, operation } = fixture();
    const node = { path, common: { body: 'base', contentType: type }, push: { body: 'retained', contentType: type, operation: operation() },
      remote: { body: '', contentType: type, revision: 'empty' } };
    expect(rs.sync.autoMerge(node)).to.equal(node);
    await rs.local.setNodes({ [path]: node });
    expect((await rs.local.get(path)).body).to.equal('retained');
    expect(node.common.body).to.equal('base'); expect(node.remote.body).to.equal('');
    await rs.sync.handleResponse(path, 'get', { statusCode: 'offline' }).catch(() => {});
    expect((await rs.local.getNodes([path]))[path].push.body).to.equal('retained');
  });

  it('does not read or mutate a different storage namespace for the same account', async function() {
    const { rs, operation, calls } = fixture();
    await rs.local.setNodes({ [path]: { path, common: {}, push: { body: 'private candidate', contentType: type, operation: operation() } } });
    rs.remote.href = 'https://example.test/storage-b/';
    await assert.rejects(rs.sync.taskUnderLease(path, true), /needs review/);
    expect(calls).to.deep.equal([]);
    expect((await rs.local.get(path)).body).to.equal('private candidate');
  });

  for (const capability of [false, undefined]) it('parks an ambiguous404 create without an atomic logical-name guarantee: ' + capability, async function() {
    const { rs, operation, calls } = fixture(); rs.remote.supportsAtomicCreate = capability;
    await rs.local.setNodes({ [path]: { path, common: {}, local: { body: 'candidate', contentType: type },
      push: { body: 'candidate', contentType: type, operation: operation('create', {}) } } });
    await assert.rejects(rs.sync.recoverPush(path, 'create', { statusCode: 404 }), /needs review/);
    const node = (await rs.local.getNodes([path]))[path];
    expect(node.push.operation.state).to.equal('conflict');
    expect(node.push.operation.observed.body).to.equal(false);
    expect(node.local.body).to.equal('candidate'); expect(calls).to.deep.equal([]);
  });

  it('retains legacy unowned writes for export without guessing that a live owner died', async function() {
    const { rs, calls } = fixture();
    await rs.local.setNodes({ [path]: { path, common: { body: '', contentType: type }, push: { body: 'legacy candidate', contentType: type } } });
    await assert.rejects(rs.sync.taskUnderLease(path, true), /needs review/);
    expect((await rs.sync.listInterruptedWrites())[0].push.body).to.equal('legacy candidate');
    expect((await rs.local.get(path)).body).to.equal('legacy candidate'); expect(calls).to.deep.equal([]);
  });

  it('keeps explicit empty text, deletion and unknown-body cache states distinct', async function() {
    const { rs } = fixture();
    await rs.local.setNodes({
      '/notes/empty': { path: '/notes/empty', common: { body: '', contentType: type } },
      '/notes/deleted': { path: '/notes/deleted', common: { body: 'old', contentType: type }, local: { body: false } },
      '/notes/unknown': { path: '/notes/unknown', common: {} }
    });
    expect(await rs.local.get('/notes/empty')).to.include({ statusCode: 200, body: '' });
    expect((await rs.local.get('/notes/deleted')).statusCode).to.equal(404);
    const unknown = (await rs.local.getNodes(['/notes/unknown']))['/notes/unknown'];
    expect(unknown.common).not.to.have.property('body'); expect(rs.sync.needsFetch(unknown)).to.equal(true);
    const changes = []; rs.local.emitChange = change => changes.push(change);
    expect(rs.sync.autoMerge({ path, common: { body: '', contentType: type } })).to.equal(undefined);
    expect(changes[0]).to.include({ oldValue: '', newValue: undefined, origin: 'remote' });
  });
});
