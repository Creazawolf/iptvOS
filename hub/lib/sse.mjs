// Server-Sent Events: the TV and the web admin learn straight away when something changes.
//   event: rev       data: {"rev":N}        curation, favourites, playlists or catalogue changed
//   event: continue  data: {"count":N}      "Continue watching" changed
//   event: status    data: {...}            fetch status (only of interest to the admin)
// A comment line every 25 seconds keeps the connection alive through proxies.
import { langOf } from './i18n.mjs';

export class Sse {
  constructor() {
    this.clients = new Set();
    this.timer = setInterval(() => {
      for (const c of this.clients) c.res.write(': ping\n\n');
    }, 25000);
    this.timer.unref();
    this.lastTvSeen = null;
  }

  add(req, res, { rev, kind = 'tv' } = {}) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 3000\n\n');
    if (rev != null) res.write(`event: rev\ndata: ${JSON.stringify({ rev })}\n\n`);
    // lang: ?lang= (EventSource can't set headers), Accept-Language or the hub's language.
    const client = { res, kind, since: Date.now(), addr: req.socket.remoteAddress, lang: langOf(req) };
    this.clients.add(client);
    if (kind === 'tv') this.lastTvSeen = Date.now();
    req.on('close', () => {
      this.clients.delete(client);
      if (kind === 'tv') this.lastTvSeen = Date.now();
    });
  }

  // data can be a function of the client's language: (lang) => data.
  broadcast(event, data, onlyKind) {
    const byLang = new Map();
    const msgFor = (lang) => {
      if (!byLang.has(lang)) byLang.set(lang, `event: ${event}\ndata: ${JSON.stringify(typeof data === 'function' ? data(lang) : data)}\n\n`);
      return byLang.get(lang);
    };
    for (const c of this.clients) if (!onlyKind || c.kind === onlyKind) c.res.write(msgFor(typeof data === 'function' ? c.lang : ''));
  }

  count(kind) {
    let n = 0;
    for (const c of this.clients) if (!kind || c.kind === kind) n++;
    return n;
  }

  close() {
    clearInterval(this.timer);
    for (const c of this.clients) c.res.end();
    this.clients.clear();
  }
}
