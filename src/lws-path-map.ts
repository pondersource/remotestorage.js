// Provisional rs.js convention, not an LWS protocol requirement.
const INDEX_MEDIA_TYPE = 'application/vnd.remotestorage.lws-index+json';
type Send = (url: string, init?: RequestInit) => Promise<Response>;
type Index = { url: string; revision: string; entries: Record<string, string> };

function validPath(path: string): void {
  if (!path.startsWith('/') || path.endsWith('/') || path.startsWith('//') || /[?#\\]/.test(path) ||
    path.slice(1).split('/').some(part => !part || ['.', '..'].includes(decodeURIComponent(part)) || /[\\/]/.test(decodeURIComponent(part)))) {
    throw new Error('Invalid rs.js path in the LWS index.');
  }
}

function links(header: string, relation: string, base: string): string[] {
  const found = [];
  for (const match of (header || '').matchAll(/<([^>]*)>((?:[^"<,]|"(?:[^"\\]|\\.)*")*)/g)) {
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^;\s,]+))/i.exec(match[2]);
    if ((rel?.[1] || rel?.[2] || '').split(/\s+/).includes(relation)) { found.push(new URL(match[1], base).href); }
  }
  return [...new Set<string>(found)];
}

/** A pod-side CAS index for rs.js names and server-assigned LWS resource IDs.
 * No access tokens or file contents are stored in the index. An ambiguous index
 * or an interrupted non-idempotent POST fails closed rather than being retried.
 */
class LWSPathMap {
  cache: Index;
  private writes: Promise<unknown> = Promise.resolve();
  private storage: string;
  private root: string;
  private send: Send;
  constructor(storage: string, root: string, send: Send) { this.storage = storage; this.root = root; this.send = send; }

  private resource(value: string, base = this.root): string {
    const url = new URL(value, base);
    if (typeof value !== 'string' || url.origin !== new URL(this.root).origin || url.username || url.password || url.hash) {
      throw new Error('Invalid resource URL in the LWS index.');
    }
    return url.href;
  }

  async rootItems(): Promise<any[]> {
    let url = this.root;
    const visited = new Set<string>(), items = [];
    while (url) {
      if (visited.has(url) || visited.size >= 1000) { throw new Error('Invalid LWS pagination loop.'); }
      visited.add(url);
      const response = await this.send(url, { headers: { Accept: 'application/lws+json' } });
      if (!response.ok) { throw new Error('Cannot read the LWS root (HTTP ' + response.status + ').'); }
      const page = await response.json();
      if (!Array.isArray(page.items) || new URL(page.id, url).href !== this.root) { throw new Error('Invalid LWS root container.'); }
      for (const item of page.items) { items.push({ ...item, id: this.resource(item.id, url) }); }
      const next = links(response.headers.get('link'), 'next', url);
      if (next.length > 1) { throw new Error('Ambiguous LWS next page.'); }
      url = next.length ? this.resource(next[0]) : undefined;
    }
    return items;
  }

  private async read(url: string): Promise<Index> {
    const response = await this.send(url, { headers: { Accept: INDEX_MEDIA_TYPE } });
    if (!response.ok) { throw new Error('Cannot read the rs.js LWS index (HTTP ' + response.status + ').'); }
    if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== INDEX_MEDIA_TYPE) {
      throw new Error('The LWS index returned an unexpected media type.');
    }
    const revision = response.headers.get('etag');
    if (!revision || revision.startsWith('W/')) { throw new Error('The LWS index needs an exposed strong ETag for safe sync.'); }
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) { throw new Error('The rs.js LWS index is too large.'); }
    const data = JSON.parse(text);
    if (data.version !== 1 || data.storage !== this.storage || !data.entries || Array.isArray(data.entries) || typeof data.entries !== 'object') {
      throw new Error('Invalid rs.js LWS index.');
    }
    const entries = Object.create(null), used = new Set<string>();
    for (const [path, value] of Object.entries(data.entries)) {
      validPath(path);
      const resource = this.resource(value as string);
      if (resource === url || resource === this.root || resource === this.storage || used.has(resource)) { throw new Error('Invalid or duplicate LWS index target.'); }
      used.add(resource); entries[path] = resource;
    }
    const names = Object.keys(entries);
    for (const name of names) {
      const parts = name.split('/');
      for (let i = 2; i < parts.length; i++) { if (entries[parts.slice(0, i).join('/')]) { throw new Error('File/folder collision in the LWS index.'); } }
    }
    return { url, revision, entries };
  }

  private async indexCandidates(items): Promise<string[]> {
    const candidates = new Set<string>();
    const unknown = [];
    for (const item of items) {
      const types = Array.isArray(item.type) ? item.type : [item.type];
      if (types.includes('Container') || types.includes('https://www.w3.org/ns/lws#Container')) { continue; }
      const type = item.format?.split(';')[0].trim().toLowerCase();
      if (type === INDEX_MEDIA_TYPE) { candidates.add(item.id); }
      else if (!type || type === 'application/octet-stream') { unknown.push(item.id); }
    }
    // Some container projections lose a member's stored media type. HEAD is
    // authoritative and avoids downloading arbitrary native/binary resources.
    let next = 0;
    const worker = async () => {
      while (next < unknown.length) {
        const url = unknown[next++];
        const response = await this.send(url, { method: 'HEAD' });
        if (response.status === 404) { continue; }
        if (!response.ok) { throw new Error('Cannot discover an LWS member media type (HTTP ' + response.status + ').'); }
        const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
        if (!type) { throw new Error('The LWS member did not expose its media type.'); }
        if (type === INDEX_MEDIA_TYPE) { candidates.add(url); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, unknown.length) }, worker));
    return [...candidates];
  }

  async load(): Promise<Index> {
    const candidates = await this.indexCandidates(await this.rootItems());
    if (candidates.length > 1) { throw new Error('Multiple rs.js LWS indexes were found. Resolve this setup conflict before syncing.'); }
    this.cache = candidates.length ? await this.read(candidates[0]) : undefined;
    return this.cache;
  }

  private body(entries: Record<string, string>): string {
    return JSON.stringify({ version: 1, storage: this.storage, entries });
  }

  private async created(response: Response, parent: string): Promise<string> {
    if (response.status !== 201 || !response.headers.get('location')) { throw new Error('LWS creation did not expose a Location header; the POST will not be retried.'); }
    const url = this.resource(response.headers.get('location'), parent);
    if (url === this.root || url === this.storage || url === this.cache?.url) { throw new Error('LWS creation returned an existing control resource.'); }
    return url;
  }

  private async ensure(): Promise<Index> {
    const existing = await this.load();
    if (existing) { return existing; }
    const response = await this.send(this.root, { method: 'POST', headers: { 'Content-Type': INDEX_MEDIA_TYPE, Slug: 'remotestorage-index.json' }, body: this.body({}) });
    const url = await this.created(response, this.root);
    // Scan again, so concurrent first-time setup cannot silently fork the namespace.
    const index = await this.load();
    if (!index || index.url !== url) { throw new Error('The new rs.js LWS index could not be rediscovered.'); }
    return index;
  }

  private async change(path: string, expected: string, value?: string): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await this.load();
      if (!current) { throw new Error('The rs.js LWS index disappeared.'); }
      if (current.entries[path] !== expected) { return false; }
      if (value && Object.keys(current.entries).some(key => key.startsWith(path + '/') || path.startsWith(key + '/'))) { return false; }
      const entries = { ...current.entries };
      if (value) { entries[path] = value; } else { delete entries[path]; }
      const response = await this.send(current.url, { method: 'PUT',
        headers: { 'Content-Type': INDEX_MEDIA_TYPE, 'If-Match': current.revision }, body: this.body(entries) });
      if (response.status === 412) { continue; }
      if (!response.ok) { throw new Error('Could not commit the rs.js LWS index (HTTP ' + response.status + ').'); }
      this.cache = undefined;
      return true;
    }
    throw new Error('The rs.js LWS index kept changing. Try syncing again.');
  }

  create(path: string, body: BodyInit, contentType: string, expected?: string): Promise<Response> {
    validPath(path);
    const operation = this.writes.then(async () => {
      const index = await this.ensure();
      if (index.entries[path] !== expected || Object.keys(index.entries).some(key => key.startsWith(path + '/') || path.startsWith(key + '/'))) { return new Response(null, { status: 412 }); }
      const response = await this.send(this.root, { method: 'POST', headers: { 'Content-Type': contentType, Slug: encodeURIComponent(path.split('/').pop()) }, body });
      if (response.status !== 201) { return response; }
      const url = await this.created(response, this.root);
      // POST is intentionally never retried. On an indeterminate commit failure the
      // resource is retained, since a successful index write may have lost its response.
      if (!(await this.change(path, expected, url))) {
        const head = await this.send(url, { method: 'HEAD' });
        const etag = head.headers.get('etag');
        if (head.ok && etag && !etag.startsWith('W/')) { await this.send(url, { method: 'DELETE', headers: { 'If-Match': etag } }); }
        return new Response(null, { status: 412 });
      }
      // Refresh the map for synchronous BaseClient.getItemURL callers.
      await this.load();
      return response;
    });
    this.writes = operation.catch(() => {});
    return operation;
  }

  async forget(path: string, url: string): Promise<void> {
    await this.change(path, url);
    await this.load();
  }

  lookup(path: string): string { return this.cache?.entries[path]; }
  isInternal(url: string): boolean { return url === this.cache?.url || Object.values(this.cache?.entries || {}).includes(url); }

  async listing(path: string): Promise<Record<string, any>> {
    const grouped = new Map<string, string[]>(), result = Object.create(null);
    for (const [key, url] of Object.entries(this.cache?.entries || {})) {
      if (!key.startsWith(path)) { continue; }
      const relative = key.slice(path.length), slash = relative.indexOf('/');
      const name = slash < 0 ? relative : relative.slice(0, slash + 1);
      const head = await this.send(url, { method: 'HEAD' });
      if (head.status === 404) { continue; }
      if (!head.ok) { throw new Error('Cannot read mapped LWS member metadata (HTTP ' + head.status + ').'); }
      const revision = head.headers.get('etag');
      if (!revision) { throw new Error('Mapped LWS member ETag was not exposed.'); }
      if (slash < 0) {
        result[name] = { ETag: revision.replace(/^"|"$/g, ''), 'Content-Type': head.headers.get('content-type') };
      } else {
        if (!grouped.has(name)) { grouped.set(name, []); }
        grouped.get(name).push(JSON.stringify([key, url, revision]));
      }
    }
    for (const [name, revisions] of grouped) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(revisions.sort().join('\n')));
      result[name] = { ETag: Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('') };
    }
    return result;
  }
}

export = LWSPathMap;
