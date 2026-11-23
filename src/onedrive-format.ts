/** Versioned, single-item records preserve MIME types and arbitrary rs.js names.
 * One Graph item is one atomic revision; there are no independently updated sidecars.
 */
export interface OneDriveRecord {
  version: 1;
  contentType: string;
  data: string;
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) { binary += String.fromCharCode(byte); }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unbase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new Error('Invalid OneDrive record encoding.');
  }
  const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
  if (base64url(bytes) !== value) { throw new Error('Non-canonical OneDrive record encoding.'); }
  return bytes;
}

export function encodeName(name: string): string {
  const encoded = 'rs-' + base64url(new TextEncoder().encode(name));
  if (!name || name === '.' || name === '..' || (/[\/\\]/.test(name) || name.includes(String.fromCharCode(0))) || encoded.length > 240) {
    throw new Error('Unsupported OneDrive storage name.');
  }
  return encoded;
}

export function decodeName(name: string): string | undefined {
  if (!name.startsWith('rs-')) { return undefined; }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(unbase64url(name.slice(3)));
    return encodeName(decoded) === name ? decoded : undefined;
  } catch { return undefined; }
}

export function pathSegments(path: string): string[] {
  if (!path.startsWith('/') || path.includes('//')) { throw new Error('Invalid OneDrive storage path.'); }
  return path.slice(1).replace(/\/$/, '').split('/').filter(Boolean).map(encodeName);
}

export async function encodeRecord(body: XMLHttpRequestBodyInit, contentType: string): Promise<string> {
  let bytes: Uint8Array;
  if (typeof body === 'string') { bytes = new TextEncoder().encode(body); }
  else if (body instanceof ArrayBuffer) { bytes = new Uint8Array(body); }
  else if (ArrayBuffer.isView(body)) { bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength); }
  else if (typeof Blob !== 'undefined' && body instanceof Blob) { bytes = new Uint8Array(await body.arrayBuffer()); }
  else { throw new Error('OneDrive supports strings, ArrayBuffers, typed arrays and Blobs.'); }
  // Graph's single-request upload limit is 250 MB; leave room for base64 and JSON.
  if (bytes.length > 180 * 1024 * 1024) { throw new Error('OneDrive records larger than 180 MiB require an upload session.'); }
  return JSON.stringify({ version: 1, contentType, data: base64url(bytes) } satisfies OneDriveRecord);
}

export function decodeRecord(value: unknown): { body: any; contentType: string } {
  const record = value as OneDriveRecord;
  if (record?.version !== 1 || typeof record.contentType !== 'string' || typeof record.data !== 'string') {
    throw new Error('Unrecognized OneDrive rs.js record; leaving it unchanged.');
  }
  const bytes = unbase64url(record.data);
  const textual = /^(text\/|application\/(.*\+)?json(?:;|$)|application\/(sparql-update|xml|javascript)(?:;|$))/.test(record.contentType);
  const charset = record.contentType.match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1].toLowerCase();
  let text: string;
  if (textual && (!charset || ['utf-8', 'utf8'].includes(charset))) {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { /* Keep non-UTF-8 files readable as their original bytes. */ }
  }
  // Match WireClient's transport contract: JSON files are serialized text.
  // BaseClient.getObject parses them; Sync compares these original bytes with
  // the serialized common version before adopting a missing write validator.
  return { contentType: record.contentType, body: text === undefined ? bytes.buffer : text };
}
