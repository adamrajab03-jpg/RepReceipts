// Parity: frontend tokenizeTurn.ts  ≡  backend/src/utils/wordAlign.js. Run:
//   cd frontend && node --test src/utils/tokenizeTurn.parity.test.mjs
//
// The public page renders words with the frontend aligner; citations derive
// their timestamps and re-locate passages with the backend port. If the two
// ever disagree, a shared quote's "Watch this moment" and its highlight drift
// apart from what the reader sees. This runs both over the same inputs — the
// hand-written edit shapes the aligner exists for, plus a few hundred seeded
// random edits — and demands identical tokens AND identical timing placement
// (which word_times entry, by index, each token received).
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const { outputFiles } = await build({
  entryPoints: [path.join(here, 'tokenizeTurn.ts')],
  bundle: true, write: false, format: 'esm', platform: 'neutral',
});
const front = await import('data:text/javascript;base64,' + Buffer.from(outputFiles[0].text).toString('base64'));
const back = createRequire(import.meta.url)(path.join(here, '../../../backend/src/utils/wordAlign.js'));

/** Tokens as comparable plain data: timing identified by its index in wordTimes. */
const shape = (tokens, wordTimes) =>
  tokens.map((t) => [t.word, t.charStart, t.charEnd, t.wt ? wordTimes.indexOf(t.wt) : -1]);

function same(name, text, wordTimes) {
  const f = shape(front.tokenizeText(text, wordTimes), wordTimes ?? [])
  const b = shape(back.tokenizeText(text, wordTimes), wordTimes ?? [])
  assert.deepEqual(b, f, `backend ≠ frontend for: ${name}`)
}

// raw words → word_times on a steady 300 ms/word clock
const timed = (raw) => raw.split(/\s+/).filter(Boolean).map((w, i) => ({ w, s: 1000 + i * 300, e: 1000 + i * 300 + 250 }))

const RAW = 'so the the bill um that we passed Killamen said is uh a good bill for America'

test('hand-written edit shapes', () => {
  const wt = timed(RAW)
  same('unchanged', RAW, wt)
  same('filler removed', 'so the the bill that we passed Killamen said is a good bill for America', wt)
  same('stutter collapsed', 'so the bill um that we passed Killamen said is uh a good bill for America', wt)
  same('name swapped (equal-size gap)', 'so the the bill um that we passed Kimmelman said is uh a good bill for America', wt)
  same('punctuation + case', 'So the the bill, um, that we passed — Killamen said — is uh a good bill for America.', wt)
  same('word inserted', 'so the the bill um that we passed Killamen said is uh a really good bill for America', wt)
  same('whole rewrite', 'completely different words replaced this entire passage today', wt)
  same('extra whitespace', '  so  the the\tbill um that we passed Killamen said is uh a good bill for America  ', wt)
  same('empty text', '', wt)
  same('null word_times', RAW, null)
  same('empty word_times', RAW, [])
  same('missing w on an entry', RAW, wt.map((x, i) => (i === 3 ? { s: x.s, e: x.e } : x)))
})

test('LCS budget cut-off behaves identically', () => {
  // > MAX_LCS_CELLS (250k) in the disputed middle: both must skip the LCS.
  const a = Array.from({ length: 600 }, (_, i) => `alpha${i}`).join(' ')
  const b = Array.from({ length: 600 }, (_, i) => `beta${i}`).join(' ')
  same('huge disputed middle', `start ${b} end`, timed(`start ${a} end`))
})

test('seeded random edits', () => {
  // mulberry32 — deterministic, so a failure is reproducible by seed.
  let seed = 0x5eed
  const rnd = () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)]
  const VOCAB = ['the', 'bill', 'senator', 'we', 'must', 'act', 'now', 'uh', 'um', 'I', 'think', 'that', 'is', 'a', 'good', 'point', 'Chairman', 'thank', 'you', 'data', 'privacy', "don't", 'well-known']
  const EDITS = [
    (ws, i) => ws.splice(i, 1),                                         // delete
    (ws, i) => ws.splice(i, 0, pick(VOCAB)),                            // insert
    (ws, i) => { ws[i] = pick(VOCAB) },                                 // replace
    (ws, i) => { ws[i] = ws[i].toUpperCase() },                         // case
    (ws, i) => { ws[i] = ws[i] + pick([',', '.', '?', '—', '"']) },     // trailing punctuation
    (ws, i) => { ws[i] = '"' + ws[i] },                                 // leading punctuation
    (ws, i) => { if (ws[i + 1]) ws.splice(i, 2, ws[i] + ws[i + 1]) },   // run-together
  ]

  for (let c = 0; c < 400; c++) {
    const n = 1 + Math.floor(rnd() * 60)
    const raw = Array.from({ length: n }, () => pick(VOCAB))
    const wt = timed(raw.join(' '))
    const ws = [...raw]
    const edits = Math.floor(rnd() * 6)
    for (let e = 0; e < edits && ws.length; e++) pick(EDITS)(ws, Math.floor(rnd() * ws.length))
    const sep = () => pick([' ', ' ', ' ', '  ', '\n'])
    same(`seeded case ${c}`, ws.map((w, i) => (i ? sep() : '') + w).join(''), wt)
  }
})
