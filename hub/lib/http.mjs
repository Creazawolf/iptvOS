// HTTP helpers: JSON responses (gzip for large ones), CORS, request bodies, static files.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { gzipSync } from 'node:zlib';
import { langOf, LocalError, tr } from './i18n.mjs';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Hub-Token, Accept-Language',
  'Access-Control-Max-Age': '600'
};

// new HttpError(404, 'errors.playlistNotFound', vars): the text is translated when it is sent (sendError).
export class HttpError extends LocalError {
  constructor(status, key, vars) {
    super(key, vars);
    this.status = status;
  }
}

// { error } in the language of the request (Accept-Language, else the hub's language).
export function sendError(req, res, status, e) {
  const lang = langOf(req);
  const error = e && e.key ? tr(e.key, e.vars, lang) : (e && e.message) || tr('errors.server', null, lang);
  sendJson(req, res, status, { error });
}

export function sendJson(req, res, status, data) {
  let body = Buffer.from(JSON.stringify(data));
  const headers = { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (body.length > 4096 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    body = gzipSync(body, { level: 4 });
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

export function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'errors.tooLarge'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'errors.badJson'));
      }
    });
    req.on('error', reject);
  });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
};

export async function serveStatic(req, res, root, urlPath) {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '') || 'index.html';
  const file = join(root, rel);
  if (!file.startsWith(root)) return false;
  let st;
  try {
    st = await stat(file);
    if (!st.isFile()) return false;
  } catch {
    return false;
  }
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const ext = extname(file);
  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.woff2' ? 'public, max-age=2592000' : 'no-cache',
    ETag: etag
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers).end();
    return true;
  }
  headers['Content-Length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
  return true;
}
