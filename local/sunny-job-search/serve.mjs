#!/usr/bin/env node

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, normalize, resolve, sep } from 'node:path';

const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

export function resolveRequest(root, rawPath) {
  let pathname;
  try { pathname = decodeURIComponent(rawPath.split('?')[0]); } catch { return { status: 400 }; }
  if (pathname.split('/').includes('..')) return { status: 403 };
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const path = resolve(root, normalize(relative));
  if (!path.startsWith(`${resolve(root)}${sep}`) && path !== resolve(root)) return { status: 403 };
  return { status: 200, path, contentType: MIME_TYPES[extname(path)] || 'application/octet-stream' };
}

export function startServer({ root = import.meta.dirname, host = '127.0.0.1', port = 4173 } = {}) {
  const server = createServer((request, response) => {
    const target = resolveRequest(root, request.url || '/');
    if (target.status !== 200) { response.writeHead(target.status); response.end('Forbidden'); return; }
    if (!existsSync(target.path) || !statSync(target.path).isFile()) { response.writeHead(404); response.end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': target.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    createReadStream(target.path).pipe(response);
  });
  server.listen(port, host, () => console.log(`Sunny Job Search is running at http://${host}:${port}`));
  return server;
}

if (process.argv[1] === new URL(import.meta.url).pathname) startServer({ port: Number(process.env.PORT || 4173) });
