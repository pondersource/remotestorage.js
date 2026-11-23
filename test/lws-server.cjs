const http = require('node:http');
exports.createServer = async function createServer({ rootPath = '/root' } = {}) {
  const resources = new Map(), requests = [];
  let sequence = 0, revision = 0, base;
  const handler = async (req, res) => {
    const url = new URL(req.url, base), method = req.method;
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({ path: req.url, method, headers: req.headers, body });
    const reply = (status, value = '', headers = {}) => {
      res.writeHead(status, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'ETag, Link, Location, WWW-Authenticate', Link: '<' + base + '/storage>; rel="https://www.w3.org/ns/lws#storage"', ...headers });
      res.end(method === 'HEAD' ? '' : value);
    };
    if (method === 'OPTIONS') return reply(204, '', { 'Access-Control-Allow-Methods': 'GET,HEAD,POST,PUT,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type,If-Match,If-None-Match,Slug' });
    if (url.pathname === '/storage') return reply(200, JSON.stringify({ id: base + '/storage', type: 'Storage', service: [{ type: 'StorageRoot', serviceEndpoint: base + rootPath }] }), { 'Content-Type': 'application/lws+cid' });
    if (url.pathname === rootPath) {
      if (method === 'GET') return reply(200, JSON.stringify({ id: base + rootPath, type: 'Container', items: [...resources].map(([id, r]) => ({ id, type: 'DataResource', format: r.type, size: Buffer.byteLength(r.body) })) }), { 'Content-Type': 'application/lws+json', ETag: '"root-' + revision + '"' });
      if (method === 'POST') {
        const path = '/objects/' + (++sequence);
        const item = { body, type: req.headers['content-type'], revision: ++revision };
        resources.set(base + path, item);
        return reply(201, '', { Location: path, ETag: '"' + item.revision + '"' });
      }
    }
    const item = resources.get(url.href);
    if (!item) return reply(404);
    const etag = '"' + item.revision + '"';
    if (req.headers['if-match'] && req.headers['if-match'] !== etag) return reply(412);
    if (req.headers['if-none-match'] === '*' || req.headers['if-none-match'] === etag) return reply(method === 'GET' ? 304 : 412);
    if (method === 'GET' || method === 'HEAD') return reply(200, item.body, { 'Content-Type': item.type, ETag: etag });
    if (method === 'PUT') { item.body = body; item.type = req.headers['content-type']; item.revision = ++revision; return reply(204, '', { ETag: '"' + item.revision + '"' }); }
    if (method === 'DELETE') { resources.delete(url.href); revision++; return reply(204); }
    reply(405);
  };
  if (process.env.LWS_IN_MEMORY) {
    base = 'http://127.0.0.1:12345';
    return { base, resources, requests, close: async () => {}, fetch: async (url, init = {}) => {
      const target = new URL(url);
      let status, headers, body;
      const req = { url: target.pathname + target.search, method: init.method || 'GET', headers: Object.fromEntries(new Headers(init.headers)), async *[Symbol.asyncIterator]() { if (init.body) yield Buffer.from(init.body); } };
      await handler(req, { writeHead(s, h) { status = s; headers = h; }, end(b) { body = b; } });
      return new Response([204, 304].includes(status) || req.method === 'HEAD' ? null : body, { status, headers });
    } };
  }
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  return { base, resources, requests, close: () => new Promise(resolve => server.close(resolve)) };
};
