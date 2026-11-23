import { expect } from 'chai';
import LocalStorage from '../../build/localstorage.js';
import { BinaryCacheError, deserializeCacheNode, serializeCacheNode } from '../../build/cache-serialization.js';
import { deepClone, equal } from '../../build/util.js';

const bytes = value => [...new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer, value.byteOffset || 0, value.byteLength)];
const type = 'application/octet-stream';

describe('persistent binary write recovery snapshots', function() {
  it('round-trips pending bytes, a nested binary base and a known empty observed body', async function() {
    const values = new Map(), previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
      key: index => [...values.keys()][index], get length() { return values.size; } };
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    try {
      const original = new Uint8Array([77, 0, 255, 88]);
      const node = { path: '/notes/binary', common: { body: new Uint8Array([1, 2]).buffer, contentType: type },
        local: { body: new Uint8Array(original.buffer, 1, 2), contentType: type },
        push: { body: new Uint8Array([3, 4]).buffer, contentType: type, operation: {
          id: 'pending-id', destination: 'fixture', owned: true, state: 'conflict',
          base: { body: new Uint8Array([1, 2]).buffer, contentType: type, revision: 'old' },
          observed: { body: '', contentType: 'text/plain', revision: 'empty' }
        } } };
      await new LocalStorage().setNodes({ [node.path]: node });
      const fresh = new LocalStorage(), recovered = (await fresh.getNodes([node.path]))[node.path];
      expect(bytes(recovered.local.body)).to.deep.equal([0, 255]);
      expect(bytes(recovered.push.body)).to.deep.equal([3, 4]);
      expect(bytes(recovered.push.operation.base.body)).to.deep.equal([1, 2]);
      expect(recovered.push.operation.observed.body).to.equal('');
      expect(recovered.push.operation.base.revision).to.equal('old');
      const all = []; await fresh.forAllNodes(node => all.push(node));
      expect(equal(all[0], recovered)).to.equal(true);
      expect(bytes(original)).to.deep.equal([77, 0, 255, 88]);
      expect((await fresh.get('/notes/binary')).body).to.be.instanceOf(Uint8Array);
    } finally { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete globalThis.localStorage; }
  });

  it('preserves tombstones, unknown bodies and empty files distinctly', function() {
    const node = { path: '/notes/a', common: {}, local: { body: false }, push: {
      body: false, operation: { id: 'delete', destination: 'fixture', owned: true,
        base: { body: new ArrayBuffer(0), contentType: type }, observed: { body: false } }
    } };
    const recovered = deserializeCacheNode(serializeCacheNode(node));
    expect(recovered.common).not.to.have.property('body');
    expect(recovered.local.body).to.equal(false);
    expect(recovered.push.operation.observed.body).to.equal(false);
    expect(recovered.push.operation.base.body.byteLength).to.equal(0);
    const text = { path: '/notes/text', local: { body: '', contentType: 'text/plain' } };
    expect(serializeCacheNode(text)).to.equal(JSON.stringify(text));
  });

  it('does not reinterpret ordinary JSON body objects as binary markers', function() {
    const body = { format: 'remotestorage-cache-binary', version: 1, node: { path: 'foreign' }, bodies: {} };
    const node = { path: '/notes/json', common: { body, contentType: 'application/json' } };
    expect(deserializeCacheNode(serializeCacheNode(node))).to.deep.equal(node);
    expect(() => deserializeCacheNode(JSON.stringify({ format: body.format, version: 99, node }))).to.throw(BinaryCacheError);
  });

  it('clones nested binary snapshots without structuredClone and compares active wire bytes', function() {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'structuredClone');
    Object.defineProperty(globalThis, 'structuredClone', { configurable: true, value: undefined });
    try {
      const original = { push: { operation: { base: { body: new Uint8Array([0, 255]).buffer } } }, view: new DataView(new Uint8Array([3, 4]).buffer) };
      const copy = deepClone(original);
      expect(bytes(copy.push.operation.base.body)).to.deep.equal([0, 255]);
      expect(bytes(copy.view)).to.deep.equal([3, 4]);
      expect(copy.push.operation.base.body).not.to.equal(original.push.operation.base.body);
      expect(equal(new Uint8Array([0, 255]), original.push.operation.base.body)).to.equal(true);
      expect(equal(new Uint8Array([0, 254]), original.push.operation.base.body)).to.equal(false);
    } finally { Object.defineProperty(globalThis, 'structuredClone', previous); }
  });
});
