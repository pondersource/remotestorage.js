import type { RSItem, RSNode } from './interfaces/rs_node';
import { globalContext } from './util';

const FORMAT = 'remotestorage-cache-binary';
const VIEW_TYPES = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'DataView'];

export class BinaryCacheError extends Error {}

function slots(node: RSNode): Record<string, RSItem> {
  return { common: node.common, local: node.local, remote: node.remote, push: node.push,
    base: node.push?.operation?.base, observed: node.push?.operation?.observed };
}

/** Text-only rows retain their legacy representation. Binary rows use an outer
 * envelope, so arbitrary JSON body objects cannot collide with binary markers.
 */
export function serializeCacheNode(node: RSNode): string {
  if (!node) { return JSON.stringify(node); }
  const bodies: Record<string, { type: string; data: string }> = {};
  for (const [key, item] of Object.entries(slots(node))) {
    const body = item?.body;
    if (!(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) { continue; }
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    let binary = '';
    for (const byte of bytes) { binary += String.fromCharCode(byte); }
    const type = body instanceof ArrayBuffer ? 'ArrayBuffer' : Object.prototype.toString.call(body).slice(8, -1);
    bodies[key] = { type, data: btoa(binary) };
  }
  if (!Object.keys(bodies).length) { return JSON.stringify(node); }
  const copy: RSNode = { ...node, common: node.common && { ...node.common }, local: node.local && { ...node.local },
    remote: node.remote && { ...node.remote }, push: node.push && { ...node.push } };
  if (copy.push?.operation) {
    copy.push.operation = { ...copy.push.operation, base: { ...copy.push.operation.base },
      observed: copy.push.operation.observed && { ...copy.push.operation.observed } };
  }
  const targets = slots(copy);
  for (const key of Object.keys(bodies)) { targets[key].body = null; }
  return JSON.stringify({ format: FORMAT, version: 1, node: copy, bodies });
}

export function deserializeCacheNode(text: string): RSNode | undefined {
  const value = JSON.parse(text);
  if (!value || typeof value.path === 'string' || value.format !== FORMAT) { return value || undefined; }
  if (value.version !== 1 || !value.node || typeof value.node.path !== 'string' || !value.bodies ||
      typeof value.bodies !== 'object' || !Object.keys(value.bodies).length) {
    throw new BinaryCacheError('Unsupported binary cache record. Local data has been retained.');
  }
  const targets = slots(value.node);
  for (const [key, encoded] of Object.entries(value.bodies) as [string, { type: string; data: string }][]) {
    if (!Object.prototype.hasOwnProperty.call(targets, key) || !targets[key] || targets[key].body !== null ||
        typeof encoded?.data !== 'string' || (encoded.type !== 'ArrayBuffer' && !VIEW_TYPES.includes(encoded.type))) {
      throw new BinaryCacheError('Invalid binary cache record. Local data has been retained.');
    }
    let bytes: Uint8Array;
    try {
      const binary = atob(encoded.data);
      if (btoa(binary) !== encoded.data) { throw new Error('Non-canonical encoding'); }
      bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    } catch { throw new BinaryCacheError('Invalid binary cache bytes. Local data has been retained.'); }
    const buffer = bytes.buffer as ArrayBuffer;
    if (encoded.type === 'ArrayBuffer') { targets[key].body = buffer; }
    else {
      const constructor = globalContext[encoded.type] as { new(buffer: ArrayBuffer): ArrayBufferView };
      try { targets[key].body = constructor ? new constructor(buffer) : buffer; }
      catch { throw new BinaryCacheError('Invalid binary cache view. Local data has been retained.'); }
    }
  }
  return value.node;
}
