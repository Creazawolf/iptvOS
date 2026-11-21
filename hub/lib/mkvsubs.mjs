// Streaming extraction of text tracks (subtitles) from Matroska (.mkv), without decoding anything else.
//
// Why: LG's video pipeline drops text in ASS tracks (everything before the first comma in each line
// disappears, lines without a comma are not shown at all – seen on the G3 2026-11-21). The provider
// also only allows one connection, so the text cannot be fetched alongside playback.
// So the hub reads the text out of the same byte stream it passes on to the TV (see stream.mjs),
// and the launcher draws it itself.
//
//   const file = new MkvFile();
//   const p = new MkvSubParser(file, startOffset);   // one per HTTP response (byte range)
//   p.push(chunk) …                                  // in the order the bytes arrive
//   file.tracks   [{ index, number, codec, text, lang, name, default, forced }]
//   file.cuesOf(index)  [[start, end, text], …] (seconds, in order of arrival)
//
// The parser skips everything that is not a track description or a block in a text track (just a counter
// of how many bytes to let past), so it keeps up with video at full speed. If a response starts in the middle of
// the file, it finds the first cluster and carries on from there.
import { inflateSync } from 'node:zlib';

const ID = {
  Segment: 0x18538067, SeekHead: 0x114d9b74, Info: 0x1549a966, TimecodeScale: 0x2ad7b1, Tracks: 0x1654ae6b,
  TrackEntry: 0xae, TrackNumber: 0xd7, TrackType: 0x83, CodecID: 0x86, Language: 0x22b59c, LanguageBCP47: 0x22b59d,
  Name: 0x536e, FlagDefault: 0x88, FlagForced: 0x55aa, ContentEncodings: 0x6d80, ContentEncoding: 0x6240,
  ContentCompression: 0x5034, ContentCompAlgo: 0x4254, ContentCompSettings: 0x4255, Cluster: 0x1f43b675, Timecode: 0xe7,
  SimpleBlock: 0xa3, BlockGroup: 0xa0, Block: 0xa1, BlockDuration: 0x9b, Cues: 0x1c53bb6b, Tags: 0x1254c367,
  Attachments: 0x1941a469, Chapters: 0x1043a770
};
const MASTERS = new Set([ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.ContentEncodings, ID.ContentEncoding, ID.ContentCompression, ID.Cluster, ID.BlockGroup]);
const LEVEL1 = new Set([ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.Tags, ID.Attachments, ID.Chapters]);
const READ = new Set([ID.TimecodeScale, ID.TrackNumber, ID.TrackType, ID.CodecID, ID.Language, ID.LanguageBCP47, ID.Name, ID.FlagDefault,
  ID.FlagForced, ID.ContentCompAlgo, ID.ContentCompSettings, ID.Timecode, ID.BlockDuration]);
const CLUSTER_BYTES = Buffer.from([0x1f, 0x43, 0xb6, 0x75]);
const EMPTY = Buffer.alloc(0);
const MAX_BLOCK = 256 * 1024;   // a text block is a few hundred bytes; anything bigger is not text
const MAX_LEAF = 64 * 1024;
const MAX_CUES = 20000;         // per track

const CODECS = {
  'S_TEXT/UTF8': 'srt', 'S_TEXT/ASCII': 'srt', 'S_TEXT/ASS': 'ass', 'S_ASS': 'ass', 'S_TEXT/SSA': 'ssa', 'S_SSA': 'ssa',
  'S_TEXT/WEBVTT': 'vtt', 'D_WEBVTT/SUBTITLES': 'vtt', 'S_HDMV/PGS': 'pgs', 'S_VOBSUB': 'vobsub', 'S_DVBSUB': 'dvb', 'S_TEXT/USF': 'usf'
};
const TEXT_CODECS = new Set(['srt', 'ass', 'ssa', 'vtt']);

const uint = (b) => { let v = 0; for (let i = 0; i < b.length; i++) v = v * 256 + b[i]; return v; };

// Line text from a block. ASS/SSA in Matroska: "ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text".
export function cueText(codec, raw) {
  let t = raw;
  if (codec === 'ass' || codec === 'ssa') {
    let at = 0;
    for (let i = 0; i < 8; i++) {
      at = t.indexOf(',', at);
      if (at < 0) return '';
      at++;
    }
    t = t.slice(at);
    if (/\{[^}]*\\p[1-9]/.test(t)) return ''; // drawing commands (shapes), no text
    t = t.replace(/\{[^}]*\}/g, '').replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');
  } else {
    t = t.replace(/\{\\[^}]*\}/g, '').replace(/<\/?[a-zA-Z][^>]*>/g, '').replace(/\r/g, '');
    if (codec === 'vtt') t = t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
  }
  return t.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).slice(0, 4).join('\n');
}

export class MkvFile {
  constructor() {
    this.scale = 1000000;      // ns per time unit (default 1 ms)
    this.tracks = [];          // subtitle tracks in the file's order (index 0 = first, as on the TV)
    this.byNumber = new Map();
    this.header = false;       // the track descriptions have been read
    this.cues = new Map();     // index -> { list: [[s, e, text]], keys: Set }
    this.touched = Date.now();
  }

  addTrack(e) {
    if (this.header || this.byNumber.has(e.number)) return;
    const codec = CODECS[e.codec] || e.codec.toLowerCase();
    const t = {
      index: this.tracks.length, number: e.number, codec, text: TEXT_CODECS.has(codec),
      lang: e.bcp || e.lang || 'und', name: e.name || '', default: e.def !== 0, forced: !!e.forced, comp: e.comp
    };
    this.tracks.push(t);
    this.byNumber.set(e.number, t);
  }

  addCue(index, start, end, text) {
    let c = this.cues.get(index);
    if (!c) this.cues.set(index, (c = { list: [], keys: new Set() }));
    const key = Math.round(start * 100) + '|' + text;
    if (c.keys.has(key) || c.list.length >= MAX_CUES) return; // the TV rereads the same section when seeking
    c.keys.add(key);
    c.list.push([Math.round(start * 1000) / 1000, Math.round(end * 1000) / 1000, text]);
  }

  cuesOf(index) {
    const c = this.cues.get(index);
    return c ? c.list : [];
  }

  publicTracks() {
    return this.tracks.map((t) => ({ index: t.index, codec: t.codec, text: t.text, lang: t.lang, name: t.name, default: t.default, forced: t.forced }));
  }
}

export class MkvSubParser {
  // headerOnly: stop at the first cluster (used when only the track descriptions are needed).
  constructor(file, offset = 0, { headerOnly = false } = {}) {
    this.f = file;
    this.pos = offset;         // file position of buf[0]
    this.buf = EMPTY;
    this.skip = 0;             // bytes left to skip
    this.stack = [];           // open elements: { id, end }
    this.synced = offset === 0;
    this.clusterTime = 0;
    this.entry = null;
    this.group = null;
    this.headerOnly = headerOnly;
    this.done = false;
  }

  push(chunk) {
    if (this.done || !chunk.length) return;
    if (this.skip > 0) {
      if (chunk.length <= this.skip) {
        this.skip -= chunk.length;
        this.pos += chunk.length;
        return;
      }
      chunk = chunk.subarray(this.skip);
      this.pos += this.skip;
      this.skip = 0;
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      this.run();
    } catch (e) {
      // Broken file or wrong position: start again at the next cluster rather than disturb the stream.
      this.resync(1);
    }
  }

  consume(n) {
    this.buf = this.buf.subarray(n);
    this.pos += n;
  }

  skipBytes(n) {
    if (this.buf.length >= n) {
      this.consume(n);
      return;
    }
    this.skip = n - this.buf.length;
    this.pos += this.buf.length;
    this.buf = EMPTY;
  }

  resync(drop) {
    this.consume(Math.min(drop, this.buf.length));
    this.synced = false;
    this.stack = [];
    this.entry = null;
    this.group = null;
  }

  run() {
    for (;;) {
      if (this.skip > 0 || this.done) return;
      while (this.stack.length && this.pos >= this.stack[this.stack.length - 1].end) this.close(this.stack.pop());
      if (!this.synced) {
        const i = this.buf.indexOf(CLUSTER_BYTES);
        if (i < 0) {
          const keep = Math.min(3, this.buf.length);
          this.consume(this.buf.length - keep);
          return;
        }
        this.consume(i);
        this.synced = true;
      }
      const b = this.buf;
      if (b.length < 2) return;

      // The element's id (1–4 bytes) and size (1–8 bytes, all ones = unknown size).
      const b0 = b[0];
      const idLen = b0 & 0x80 ? 1 : b0 & 0x40 ? 2 : b0 & 0x20 ? 3 : b0 & 0x10 ? 4 : 0;
      if (!idLen) { this.resync(1); continue; }
      if (b.length < idLen + 1) return;
      let id = 0;
      for (let i = 0; i < idLen; i++) id = id * 256 + b[i];
      const s0 = b[idLen];
      let sl = 1;
      let mask = 0x80;
      while (sl <= 8 && !(s0 & mask)) { sl++; mask >>= 1; }
      if (sl > 8) { this.resync(1); continue; }
      if (b.length < idLen + sl) return;
      let size = s0 & (mask - 1);
      let unknown = size === mask - 1;
      for (let i = 1; i < sl; i++) {
        const v = b[idLen + i];
        size = size * 256 + v;
        if (v !== 0xff) unknown = false;
      }
      const head = idLen + sl;
      const top = this.stack[this.stack.length - 1];

      // Clusters without a stated size (streamed files) end when the next level 1 element begins.
      if (top && top.end === Infinity && top.id !== ID.Segment && LEVEL1.has(id)) {
        while (this.stack.length && this.stack[this.stack.length - 1].id !== ID.Segment) this.close(this.stack.pop());
        continue;
      }
      if (id === ID.Cluster && this.headerOnly) { this.done = true; return; }

      if (MASTERS.has(id)) {
        this.consume(head);
        this.stack.push({ id, end: unknown ? Infinity : this.pos + size });
        if (id === ID.TrackEntry) this.entry = { number: 0, type: 0, codec: '', lang: '', bcp: '', name: '', def: 1, forced: 0, comp: null };
        else if (id === ID.BlockGroup) this.group = { block: null, dur: null };
        else if (id === ID.ContentCompression && this.entry) this.entry.comp = { algo: 0, settings: null };
        else if (id === ID.Cluster) this.clusterTime = 0;
        continue;
      }
      if (unknown) { this.resync(1); continue; }

      if (id === ID.SimpleBlock || id === ID.Block) {
        if (b.length < head + Math.min(size, 12)) return;
        const t0 = b[head];
        let tl = 1;
        let m = 0x80;
        while (tl <= 8 && !(t0 & m)) { tl++; m >>= 1; }
        let tn = t0 & (m - 1);
        for (let i = 1; i < tl && head + i < b.length; i++) tn = tn * 256 + b[head + i];
        const tr = this.f.byNumber.get(tn);
        if (!tr || !tr.text || size > MAX_BLOCK || size < tl + 3) {
          this.consume(head);
          this.skipBytes(size);
          continue;
        }
        if (b.length < head + size) return; // wait for the whole block (small)
        const blk = { tr, time: this.clusterTime + b.readInt16BE(head + tl), data: Buffer.from(b.subarray(head + tl + 3, head + size)), dur: null };
        this.consume(head + size);
        if (id === ID.Block && this.group) this.group.block = blk;
        else this.emit(blk);
        continue;
      }

      if (READ.has(id) && size <= MAX_LEAF) {
        if (b.length < head + size) return;
        this.leaf(id, b.subarray(head, head + size), top);
        this.consume(head + size);
        continue;
      }

      this.consume(head);
      this.skipBytes(size);
    }
  }

  leaf(id, d, top) {
    const e = this.entry;
    switch (id) {
      case ID.TimecodeScale: this.f.scale = uint(d) || 1000000; break;
      case ID.Timecode: if (top && top.id === ID.Cluster) this.clusterTime = uint(d); break;
      case ID.BlockDuration: if (this.group) this.group.dur = uint(d); break;
      case ID.TrackNumber: if (e) e.number = uint(d); break;
      case ID.TrackType: if (e) e.type = uint(d); break;
      case ID.CodecID: if (e) e.codec = d.toString('latin1').replace(/\0+$/, ''); break;
      case ID.Language: if (e) e.lang = d.toString('latin1').replace(/\0+$/, ''); break;
      case ID.LanguageBCP47: if (e) e.bcp = d.toString('latin1').replace(/\0+$/, ''); break;
      case ID.Name: if (e) e.name = d.toString('utf8').replace(/\0+$/, ''); break;
      case ID.FlagDefault: if (e) e.def = uint(d); break;
      case ID.FlagForced: if (e) e.forced = uint(d); break;
      case ID.ContentCompAlgo: if (e && e.comp) e.comp.algo = uint(d); break;
      case ID.ContentCompSettings: if (e && e.comp) e.comp.settings = Buffer.from(d); break;
      default: break;
    }
  }

  close(el) {
    if (el.id === ID.TrackEntry) {
      if (this.entry && this.entry.type === 0x11 && this.entry.number) this.f.addTrack(this.entry);
      this.entry = null;
    } else if (el.id === ID.Tracks) {
      this.f.header = true;
    } else if (el.id === ID.BlockGroup) {
      const g = this.group;
      this.group = null;
      if (g && g.block) {
        g.block.dur = g.dur;
        this.emit(g.block);
      }
    }
  }

  emit(blk) {
    let data = blk.data;
    const c = blk.tr.comp;
    if (c) {
      if (c.algo === 0) {
        try { data = inflateSync(data); } catch { return; }
      } else if (c.algo === 3 && c.settings) {
        data = Buffer.concat([c.settings, data]); // "header stripping"
      } else {
        return;
      }
    }
    const text = cueText(blk.tr.codec, data.toString('utf8'));
    if (!text) return;
    const start = (blk.time * this.f.scale) / 1e9;
    const dur = blk.dur != null ? (blk.dur * this.f.scale) / 1e9 : 4;
    if (start < 0) return;
    this.f.addCue(blk.tr.index, start, start + Math.max(0.3, Math.min(dur, 30)), text);
  }
}
