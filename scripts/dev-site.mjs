// Local copy of the Vercel setup: serves docs/ as static files and routes /api/<name>
// to the default export of api/<name>.js, the same way Vercel does.
//   node scripts/dev-site.mjs [--port 4179]
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DOCS = join(ROOT, 'docs');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.ico': 'image/x-icon' };

/** Start the dev site. `handlerOptions` is passed as the third argument to API handlers (tests inject fetch/env). */
export async function startDevSite({ port = 0, host = '127.0.0.1', handlerOptions } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const api = /^\/api\/([a-z0-9-]+)\/?$/.exec(url.pathname);
      if (api) {
        const file = join(ROOT, 'api', `${api[1]}.js`);
        try { await stat(file); } catch { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"message":"no such function"}'); }
        const mod = await import(pathToFileURL(file).href);
        return await mod.default(req, res, handlerOptions);
      }
      let path = decodeURIComponent(url.pathname);
      if (path.endsWith('/')) path += 'index.html';
      const file = normalize(join(DOCS, path));
      if (!file.startsWith(DOCS + sep)) { res.writeHead(403); return res.end(); }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (err) {
      if (!res.headersSent) res.writeHead(err.code === 'ENOENT' || err.code === 'EISDIR' ? 404 : 500, { 'content-type': 'text/plain' });
      res.end(err.code === 'ENOENT' ? 'not found' : String(err.message));
    }
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const url = `http://${host}:${server.address().port}`;
  return { url, port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--port');
  const site = await startDevSite({ port: i > -1 ? Number(process.argv[i + 1]) : 4179 });
  console.log(`shill site on ${site.url}/`);
}
