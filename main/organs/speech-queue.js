// Speak while writing (story 05). The reply is cut into sentences as it streams
// in, each sentence is synthesised on its own (at most two at a time), and the
// audio comes out in reading order, so Lyra starts talking after her first
// sentence instead of after her whole reply.
//
//   SentenceChunker  text deltas in, speakable sentences out
//   SpeechQueue      chunker + an ordered synthesis pipeline over voice.tts()
//   joinWavs         glues the spoken pieces into one file for the message
const fs = require('fs');
const { speakable } = require('./voice');

const MAX_CHUNK = 220;   // no chunk is longer than this, even a run-on sentence
const FIRST_MIN = 40;    // the first chunk may stop at a comma once it is this long
const MAX_IN_FLIGHT = 2; // synthesis requests running at the same time

// A sentence ends at . ! ? or … (closing quotes and brackets stay with it), but
// only once whitespace follows: "3.14" and "example.com" are not sentence ends,
// and a "." at the very end of the buffer may still turn out to be one of them.
const END = /[.!?…]+["'”’)\]]*(?=\s)/g;
const ABBR = /(?:^|[\s(])(?:mr|mrs|ms|dr|st|vs|etc|e\.g|i\.e|approx|fig|no)\.$/i;
const LIST_NUMBER = /^\s*\d+\.$/;
const SOFT = /[,;:—–](?=\s)/g;

// Text as it should be spoken: links keep their words, bare URLs and bullets go,
// and the rest is cleaned the same way the whole-reply path cleans it.
function speakableChunk(raw) {
  const s = String(raw || '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/^\s*[-+*•]\s+/gm, '');
  return speakable(s);
}

class SentenceChunker {
  constructor({ max = MAX_CHUNK, firstMin = FIRST_MIN } = {}) {
    this.max = max; this.firstMin = firstMin;
    this.buf = ''; this.inFence = false; this.count = 0;
  }
  // Feed a piece of streamed text; returns the chunks it completed, in order.
  push(delta) {
    this.buf += String(delta || '');
    const out = [];
    for (;;) {
      if (this.inFence) {
        const close = this.buf.indexOf('```');
        // Code is never read aloud. Keep two characters in case a fence is split across deltas.
        if (close < 0) { this.buf = this.buf.slice(-2); return out; }
        this.buf = this.buf.slice(close + 3); this.inFence = false; continue;
      }
      const fence = this.buf.indexOf('```');
      const end = this.boundary(this.buf);
      if (fence >= 0 && (end < 0 || fence < end)) {
        this.emit(this.buf.slice(0, fence), out);
        this.buf = this.buf.slice(fence + 3); this.inFence = true; continue;
      }
      if (end >= 0 && end <= this.max) { this.emit(this.buf.slice(0, end), out); this.buf = this.buf.slice(end); continue; }
      if (end > this.max || this.buf.length > this.max) { const cut = this.longCut(this.buf); this.emit(this.buf.slice(0, cut), out); this.buf = this.buf.slice(cut); continue; }
      if (!this.count && this.buf.length >= this.firstMin) {
        const cut = this.softCut(this.buf);
        if (cut > 0) { this.emit(this.buf.slice(0, cut), out); this.buf = this.buf.slice(cut); continue; }
      }
      return out;
    }
  }
  // The reply is finished: whatever is left is the last chunk.
  flush() {
    const out = [];
    if (!this.inFence) this.emit(this.buf, out);
    this.buf = ''; this.inFence = false;
    return out;
  }
  // Index just past the first sentence end or newline in s, or -1.
  boundary(s) {
    const nl = s.indexOf('\n');
    END.lastIndex = 0; let m;
    while ((m = END.exec(s))) {
      const end = m.index + m[0].length;
      if (nl >= 0 && nl < end) break;
      const head = s.slice(0, m.index + 1);
      if (m[0][0] === '.' && m[0].length === 1 && (ABBR.test(head) || LIST_NUMBER.test(head))) continue;
      return end;
    }
    return nl >= 0 ? nl + 1 : -1;
  }
  // A run-on sentence is cut at the last space that keeps it within the limit.
  longCut(s) {
    const window = s.slice(0, this.max + 1);
    const sp = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\t'));
    return sp > 0 ? sp : this.max;
  }
  // The first chunk may end at a comma, semicolon, colon or dash once it is long enough.
  softCut(s) {
    SOFT.lastIndex = 0; let m;
    while ((m = SOFT.exec(s))) { const end = m.index + 1; if (end >= this.firstMin && end <= this.max) return end; }
    return -1;
  }
  emit(raw, out) {
    const text = speakableChunk(raw);
    if (/[\p{L}\p{N}]/u.test(text)) { out.push(text); this.count++; }
  }
}

// Turns streamed text into ordered audio. Every chunk gets a seq (1, 2, 3…) and
// onChunk fires exactly once per seq, in order, even when synthesis finishes out
// of order. A chunk whose synthesis failed comes through without a path so the
// player can skip it. The last event has final: true; when the last chunk was
// already out before the reply ended, a path-less terminator carries it.
class SpeechQueue {
  constructor({ tts, onChunk = () => {}, onError = () => {}, onLimit = () => {}, maxInFlight = MAX_IN_FLIGHT, limit = speakable.LIMIT, chunker } = {}) {
    if (typeof tts !== 'function') throw new Error('SpeechQueue needs a tts(text) function');
    this.tts = tts; this.onChunk = onChunk; this.onError = onError; this.onLimit = onLimit;
    this.maxInFlight = maxInFlight; this.limit = limit;
    this.chunker = new SentenceChunker(chunker);
    this.waiting = []; this.results = new Map(); this.emitted = [];
    this.seq = 0; this.nextEmit = 1; this.inFlight = 0; this.chars = 0;
    this.ended = false; this.cancelled = false; this.truncated = false; this.finalSent = false; this.settled = false;
    this.firstChunkAt = null;
    this.done = new Promise((resolve) => { this.resolveDone = resolve; });
  }
  push(delta) {
    if (this.ended || this.cancelled) return;
    for (const c of this.chunker.push(delta)) this.enqueue(c);
  }
  finish() {
    if (this.ended || this.cancelled) return this.done;
    for (const c of this.chunker.flush()) this.enqueue(c);
    this.ended = true;
    this.drain(); this.settle();
    return this.done;
  }
  // Stop now: nothing new is synthesised or emitted, and done resolves at once.
  cancel() {
    if (this.cancelled || this.settled) return this.done;
    this.cancelled = true; this.waiting = []; this.results.clear();
    this.resolve();
    return this.done;
  }
  enqueue(text) {
    if (this.truncated) return;
    if (this.chars + text.length > this.limit) { this.truncated = true; this.onLimit(this.chars); return; }
    this.chars += text.length;
    if (!this.firstChunkAt) this.firstChunkAt = Date.now();
    this.waiting.push({ seq: ++this.seq, text });
    this.pump();
  }
  pump() {
    while (!this.cancelled && this.inFlight < this.maxInFlight && this.waiting.length) {
      const job = this.waiting.shift(); this.inFlight++;
      Promise.resolve()
        .then(() => this.tts(job.text, job))
        .then((r) => (r && r.path ? r : null), (e) => { try { this.onError(e, job); } catch {} return null; })
        .then((r) => {
          this.inFlight--;
          if (this.cancelled) return;
          this.results.set(job.seq, { ...job, path: r ? r.path : null, engine: r ? r.engine : null });
          this.drain(); this.pump(); this.settle();
        });
    }
  }
  drain() {
    while (!this.cancelled && this.results.has(this.nextEmit)) {
      const r = this.results.get(this.nextEmit); this.results.delete(this.nextEmit);
      const final = this.ended && this.nextEmit === this.seq;
      if (r.path) this.emitted.push(r);
      this.onChunk({ seq: r.seq, path: r.path, engine: r.engine, text: r.text, ...(final ? { final: true } : {}) });
      if (final) this.finalSent = true;
      this.nextEmit++;
    }
  }
  settle() {
    if (this.settled || this.cancelled || !this.ended) return;
    if (this.waiting.length || this.inFlight || this.nextEmit <= this.seq) return;
    if (!this.finalSent && this.seq > 0) { this.onChunk({ seq: this.seq + 1, path: null, final: true }); this.finalSent = true; }
    this.resolve();
  }
  resolve() {
    if (this.settled) return; this.settled = true;
    this.resolveDone({ cancelled: this.cancelled, truncated: this.truncated, chunks: this.emitted.slice() });
  }
}

// Joins WAV files that share one format into a single WAV. Returns false when
// they can't be joined byte for byte (a different engine, rate or container),
// and the caller keeps the pieces instead.
function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.length < 12 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
  let fmt = null, data = null;
  for (let o = 12; o + 8 <= b.length;) {
    const tag = b.toString('ascii', o, o + 4); let size = b.readUInt32LE(o + 4);
    // A streaming writer may leave the data size unset; it then runs to the end of the file.
    if (tag === 'data' && (size === 0 || size === 0xffffffff || o + 8 + size > b.length)) size = b.length - o - 8;
    if (tag === 'fmt ') fmt = b.subarray(o + 8, o + 8 + size);
    else if (tag === 'data') { data = b.subarray(o + 8, o + 8 + size); break; }
    o += 8 + size + (size & 1);
  }
  return fmt && data ? { fmt, data } : null;
}
function joinWavs(paths, out) {
  if (!paths.length) return false;
  let parts;
  try { parts = paths.map(readWav); } catch { return false; }
  if (parts.some((p) => !p) || parts.some((p) => !p.fmt.equals(parts[0].fmt))) return false;
  const fmt = parts[0].fmt; const dataLen = parts.reduce((n, p) => n + p.data.length, 0);
  const head = Buffer.alloc(12 + 8 + fmt.length + (fmt.length & 1) + 8);
  let o = 0;
  head.write('RIFF', o); o += 4; head.writeUInt32LE(head.length - 8 + dataLen, o); o += 4; head.write('WAVE', o); o += 4;
  head.write('fmt ', o); o += 4; head.writeUInt32LE(fmt.length, o); o += 4; fmt.copy(head, o); o += fmt.length + (fmt.length & 1);
  head.write('data', o); o += 4; head.writeUInt32LE(dataLen, o);
  fs.writeFileSync(out, Buffer.concat([head, ...parts.map((p) => p.data)]));
  return true;
}

module.exports = { SentenceChunker, SpeechQueue, joinWavs, speakableChunk, MAX_CHUNK, FIRST_MIN, MAX_IN_FLIGHT };
