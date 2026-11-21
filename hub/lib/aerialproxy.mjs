// Aerial films from servers the TV cannot fetch from itself.
//
//   GET/HEAD /api/wallpapers/video?u=<the film's address>
//
// Apple's film server (sylvan.apple.com) has a certificate issued under Apple's own root ("Apple Root
// CA"), which neither the TV nor Node has among its trusted roots – so the TV's player refuses
// (seen on the G3 2026-11-21: "unable to get local issuer certificate"). The hub fetches the film for the TV and
// checks the certificate against that particular root; the TV plays from the hub on the home network.
//
// Only the hosts in the list here are let through, and only video files. Bytes are passed on untouched with the same
// Range, nothing is stored, and the fetch is aborted as soon as the TV disconnects.
import https from 'node:https';
import { CORS, HttpError } from './http.mjs';
import { LocalError, msgOf } from './i18n.mjs';
import { log } from './util.mjs';

// Apple Root CA (sha256 B0:B1:73:0E:CB:C7:FF:45:05:14:2C:49:F1:29:5E:6E:DA:6B:CA:ED:7E:2C:68:C5:BE:91:B5:A1:10:01:F0:24,
// valid until 2035-02-09) – https://www.apple.com/certificateauthority/
const APPLE_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIIEuzCCA6OgAwIBAgIBAjANBgkqhkiG9w0BAQUFADBiMQswCQYDVQQGEwJVUzET
MBEGA1UEChMKQXBwbGUgSW5jLjEmMCQGA1UECxMdQXBwbGUgQ2VydGlmaWNhdGlv
biBBdXRob3JpdHkxFjAUBgNVBAMTDUFwcGxlIFJvb3QgQ0EwHhcNMDYwNDI1MjE0
MDM2WhcNMzUwMjA5MjE0MDM2WjBiMQswCQYDVQQGEwJVUzETMBEGA1UEChMKQXBw
bGUgSW5jLjEmMCQGA1UECxMdQXBwbGUgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkx
FjAUBgNVBAMTDUFwcGxlIFJvb3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAw
ggEKAoIBAQDkkakJH5HbHkdQ6wXtXnmELes2oldMVeyLGYne+Uts9QerIjAC6Bg+
+FAJ039BqJj50cpmnCRrEdCju+QbKsMflZ56DKRHi1vUFjczy8QPTc4UadHJGXL1
XQ7Vf1+b8iUDulWPTV0N8WQ1IxVLFVkds5T39pyez1C6wVhQZ48ItCD3y6wsIG9w
tj8BMIy3Q88PnT3zK0koGsj+zrW5DtleHNbLPbU6rfQPDgCSC7EhFi501TwN22IW
q6NxkkdTVcGvL0Gz+PvjcM3mo0xFfh9Ma1CWQYnEdGILEINBhzOKgbEwWOxaBDKM
aLOPHd5lc/9nXmW8Sdh2nzMUZaF3lMktAgMBAAGjggF6MIIBdjAOBgNVHQ8BAf8E
BAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUK9BpR5R2Cf70a40uQKb3
R01/CF4wHwYDVR0jBBgwFoAUK9BpR5R2Cf70a40uQKb3R01/CF4wggERBgNVHSAE
ggEIMIIBBDCCAQAGCSqGSIb3Y2QFATCB8jAqBggrBgEFBQcCARYeaHR0cHM6Ly93
d3cuYXBwbGUuY29tL2FwcGxlY2EvMIHDBggrBgEFBQcCAjCBthqBs1JlbGlhbmNl
IG9uIHRoaXMgY2VydGlmaWNhdGUgYnkgYW55IHBhcnR5IGFzc3VtZXMgYWNjZXB0
YW5jZSBvZiB0aGUgdGhlbiBhcHBsaWNhYmxlIHN0YW5kYXJkIHRlcm1zIGFuZCBj
b25kaXRpb25zIG9mIHVzZSwgY2VydGlmaWNhdGUgcG9saWN5IGFuZCBjZXJ0aWZp
Y2F0aW9uIHByYWN0aWNlIHN0YXRlbWVudHMuMA0GCSqGSIb3DQEBBQUAA4IBAQBc
NplMLXi37Yyb3PN3m/J20ncwT8EfhYOFG5k9RzfyqZtAjizUsZAS2L70c5vu0mQP
y3lPNNiiPvl4/2vIB+x9OYOLUyDTOMSxv5pPCmv/K/xZpwUJfBdAVhEedNO3iyM7
R6PVbyTi69G3cN8PReEnyvFteO3ntRcXqNx+IjXKJdXZD9Zr1KIkIxH3oayPc4Fg
xhtbCS+SsvhESPBgOJ4V9T0mZyCKM2r3DYLP3uujL/lTaltkwGMzd/c6ByxW69oP
IQ7aunMZT7XZNn/Bh1XZp5m5MkL72NVxnn6hUrcbvZNCJBIqxw8dtk2cXmPIS4AX
UKqK1drk/NAJBzewdXUh
-----END CERTIFICATE-----`;

const HOSTS = new Map([['sylvan.apple.com', { ca: [APPLE_ROOT_CA] }]]);
export const AERIAL_PROXY_HOSTS = [...HOSTS.keys()];

const UA = 'G3Hub (home media hub; aerial screensaver)';
const IDLE_MS = 30000;
const MAX_ACTIVE = 4; // the TV's player sometimes opens two requests (the end of the file + the start)

export class AerialProxy {
  // request: like https.request (swapped out in tests)
  constructor(request) {
    this.request = request || https.request;
    this.active = 0;
    this.served = 0;
  }

  check(u) {
    let url;
    try { url = new URL(u); } catch { throw new HttpError(400, 'errors.badAddress'); }
    if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || !HOSTS.has(url.hostname)) throw new HttpError(403, 'errors.notAerialAddress');
    if (!/\.(mov|mp4|m4v)$/i.test(url.pathname)) throw new HttpError(403, 'errors.videoFilesOnly');
    return url;
  }

  handle(req, res, u) {
    const url = this.check(u);
    if (this.active >= MAX_ACTIVE) throw new HttpError(503, 'errors.tooManyVideos');
    const headers = { 'User-Agent': UA, Accept: '*/*' };
    if (req.headers.range) headers.Range = req.headers.range;
    const head = req.method === 'HEAD';
    return new Promise((resolve, reject) => {
      const up = this.request({
        host: url.hostname, servername: url.hostname, port: 443, path: url.pathname + url.search, method: head ? 'HEAD' : 'GET',
        headers, ca: HOSTS.get(url.hostname).ca, agent: false
      }, (r) => {
        const code = r.statusCode;
        if (code >= 300 && code < 400) {
          r.resume();
          reject(new HttpError(502, 'errors.videoRedirect'));
          return;
        }
        // .mov is the same file format as .mp4 for the TV's player; the browser part does not recognise "video/quicktime".
        const type = String(r.headers['content-type'] || '');
        const h = { ...CORS, 'Accept-Ranges': 'bytes', 'Content-Type': !type || /quicktime|octet-stream/i.test(type) ? 'video/mp4' : type, 'Cache-Control': 'no-store' };
        for (const k of ['content-length', 'content-range', 'last-modified', 'etag']) if (r.headers[k]) h[k] = r.headers[k];
        res.writeHead(code, h);
        if (head || code >= 400) {
          r.resume();
          res.end();
          resolve();
          return;
        }
        this.active++;
        this.served++;
        let closed = false;
        const done = () => {
          if (closed) return;
          closed = true;
          this.active--;
          up.destroy();
          r.destroy();
        };
        r.on('data', (c) => {
          if (!res.write(c)) {
            r.pause();
            res.once('drain', () => r.resume());
          }
        });
        r.on('end', () => { res.end(); done(); });
        r.on('error', () => { res.destroy(); done(); });
        res.on('close', done); // the TV disconnected (screensaver over, next film): stop fetching at once
        res.on('error', done);
        if (!req.headers.range || /^bytes=0-/.test(req.headers.range)) log('aerial video via the hub: ' + url.pathname.split('/').pop());
        resolve();
      });
      up.setTimeout(IDLE_MS, () => up.destroy(new LocalError('errors.videoServerSilent')));
      up.on('error', (e) => reject(new HttpError(502, 'errors.videoFetch', { error: msgOf(e) })));
      up.end();
    });
  }

  status() {
    return { active: this.active, served: this.served };
  }
}
