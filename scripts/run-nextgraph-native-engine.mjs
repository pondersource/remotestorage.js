import { readFile, writeFile, mkdir, mkdtemp, copyFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'test/fixtures/nextgraph-native-engine');
const require = createRequire(import.meta.url);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function prepareNativeEngine() {
  const pins = JSON.parse(await readFile(join(fixture, 'provenance.json'), 'utf8'));
  for (const [name, hash] of Object.entries(pins.bridgeFiles)) {
    if (sha256(await readFile(join(fixture, 'api-web', name))) !== hash) {
      throw new Error(`Upstream API bridge hash mismatch: ${name}`);
    }
  }
  const ormPackage = JSON.parse(readFileSync(join(dirname(require.resolve('@ng-org/orm')), '../package.json'), 'utf8'));
  if (ormPackage.version !== pins.ormVersion) { throw new Error('Pinned ORM version mismatch'); }
  const output = await mkdtemp(join(tmpdir(), 'rs-nextgraph-native-'));
  const archive = process.env.NEXTGRAPH_WASM_ARCHIVE || '/workspace/research/nextgraph-lib-wasm/ng-org-lib-wasm-0.1.2-alpha.9.tgz';
  let archiveBytes;
  if (existsSync(archive)) { archiveBytes = await readFile(archive); }
  else {
    const response = await fetch(pins.wasm.url);
    if (!response.ok) { throw new Error(`Pinned WASM download failed (${response.status})`); }
    archiveBytes = Buffer.from(await response.arrayBuffer());
  }
  if (sha256(archiveBytes) !== pins.wasm.archiveSha256) { throw new Error('Official WASM archive checksum mismatch'); }
  const archivePath = join(output, 'engine.tgz');
  await writeFile(archivePath, archiveBytes);
  const unpack = join(output, 'engine');
  await mkdir(unpack);
  execFileSync('tar', ['-xzf', archivePath, '-C', unpack]);
  const engine = join(unpack, 'package');
  const wasm = await readFile(join(engine, 'lib_wasm_bg.wasm'));
  if (sha256(wasm) !== pins.wasm.runtimeSha256) { throw new Error('Official WASM runtime checksum mismatch'); }
  const wasmModule = await WebAssembly.compile(wasm);
  const imports = [...new Set(WebAssembly.Module.imports(wasmModule).map(item => item.module))];
  const browserImports = './snippets/lib-wasm-ec10d2ecdd85f644/jsland/browser.js';
  if (imports.length !== 2 || !imports.includes('./lib_wasm_bg.js') || !imports.includes(browserImports)) { throw new Error('Unexpected native WASM imports'); }
  const exports = WebAssembly.Module.exports(wasmModule).map(item => item.name);
  const plugins = [{ name: 'pinned-native-engine', setup(bundler) {
    bundler.onResolve({ filter: /^@ng-org\/lib-wasm$/ }, () => ({ path: join(engine, 'lib_wasm.js') }));
    bundler.onResolve({ filter: /jsland\/bowser\.js$/ }, () => ({ path: join(engine, 'snippets/lib-wasm-ec10d2ecdd85f644/jsland/bowser.js') }));
    bundler.onResolve({ filter: /\?worker&inline$/ }, args => ({ path: args.path.includes('wasm-worker') ? 'engine-worker.js' : 'wallet-worker.js', namespace: 'fixture-worker' }));
    bundler.onLoad({ filter: /.*/, namespace: 'fixture-worker' }, args => ({ contents: `export default class extends Worker {constructor(){super('/${args.path}',{type:'module'})}}`, loader: 'js' }));
    bundler.onLoad({ filter: /lib_wasm_bg\.wasm$/ }, () => ({
      contents: `import * as imports from './lib_wasm_bg.js'; import * as browser from '${browserImports}'; const {instance}=await WebAssembly.instantiateStreaming(fetch('/lib_wasm_bg.wasm'),{'./lib_wasm_bg.js':imports,${JSON.stringify(browserImports)}:browser});\n${exports.map(name => `export const ${name}=instance.exports[${JSON.stringify(name)}];`).join('\n')}`,
      loader: 'js', resolveDir: engine,
    }));
  } }];
  const options = { bundle: true, format: 'esm', target: 'es2022', platform: 'browser', plugins,
    nodePaths: [join(root, 'node_modules')], logLevel: 'silent' };
  await build({ ...options, entryPoints: [join(fixture, 'api-web/wasm-worker.js')], outfile: join(output, 'engine-worker.js') });
  await build({ ...options, entryPoints: [join(fixture, 'api-web/worker.js')], outfile: join(output, 'wallet-worker.js') });
  await build({ ...options, entryPoints: [join(fixture, 'app.js')], outfile: join(output, 'app.js') });
  await copyFile(join(engine, 'lib_wasm_bg.wasm'), join(output, 'lib_wasm_bg.wasm'));
  await writeFile(join(output, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Disposable NextGraph engine acceptance</title><script type="module" src="/app.js"></script>');
  const server = createServer(async (request, response) => {
    const path = request.url === '/' ? 'index.html' : request.url.slice(1);
    if (!['index.html', 'app.js', 'engine-worker.js', 'wallet-worker.js', 'lib_wasm_bg.wasm'].includes(path)) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', path.endsWith('.wasm') ? 'application/wasm' : path.endsWith('.js') ? 'text/javascript' : 'text/html');
    response.setHeader('Cache-Control', 'no-store');
    response.end(await readFile(join(output, path)));
  });
  // A genuine rejected transport on this fixture's own ephemeral port. Never
  // probe another local service or emulate a NextGraph broker handshake.
  server.on('upgrade', (_request, socket) => socket.destroy());
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  return { output, pins, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolveClose => server.close(resolveClose)) };
}
