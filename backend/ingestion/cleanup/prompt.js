// ============================================================================
//  Grammar-cleanup prompt construction (kept isolated so it's reviewable and
//  tunable without touching the provider or CLI — same layout as attribution).
// ----------------------------------------------------------------------------
//  Strategy: the model returns discrete EDITS (an exact `original` substring +
//  a `replacement` + a claimed `type`), never a rewritten turn. Edits-not-
//  rewrites keeps the model on a short leash and keeps output cheap. Every edit
//  is then re-classified in code by the content-word validator
//  (src/utils/cleanupValidate.js), which is authoritative — the model's `type`
//  is only a hint. The prompt's filler list is aligned to that validator's
//  auto-safe set (single-token disfluencies only); "you know" / "I mean" are
//  intentionally excluded because the validator can't tell filler usage from
//  content usage.
// ============================================================================

// Structured-outputs schema (output_config.format). The validator re-derives
// the real class from (original, replacement); `type` here is advisory only.
const CLEANUP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    turns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          turn_index: { type: 'integer' },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                original: { type: 'string' },      // exact substring of the turn, copied verbatim
                replacement: { type: 'string' },    // what it becomes ("" to delete)
                type: {
                  type: 'string',
                  enum: ['punctuation', 'capitalization', 'filler', 'false_start', 'transcription_error'],
                },
              },
              required: ['original', 'replacement', 'type'],
            },
          },
        },
        required: ['turn_index', 'edits'],
      },
    },
  },
  required: ['turns'],
};

const SYSTEM = `You are a meticulous transcription copy-editor for United States congressional hearing transcripts. These are on-the-record public statements by real senators and witnesses. Your edits must NEVER change what anyone said or meant. When in doubt, make no edit — leaving text unchanged is always the correct default.

You are given a batch of consecutive transcript turns, each with an index. For each turn, propose a list of edits. Each edit replaces one exact contiguous substring of that turn (the "original", copied VERBATIM from the text) with a "replacement", and declares its "type".

You may ONLY make these kinds of edits:
- "punctuation": add/remove/adjust punctuation and sentence-start capitalization. Do not change any letters, only punctuation and case.
- "capitalization": fix the case of a proper noun or a sentence start. Same letters, different case only.
- "filler": delete a single filler token — one of: um, umm, uh, uhh, uhm, er, erm, ah, hmm, mm, mm-hmm, uh-huh. Delete ONLY the filler token; never an adjacent content word. Do NOT remove discourse phrases like "you know" or "I mean" — leave them in the record.
- "false_start": delete an immediately self-repaired stutter where the speaker restarts the SAME words: "the the bill" -> "the bill", "we we need" -> "we need", "I— I think" -> "I think". The deleted words MUST be a verbatim repetition of the words that immediately follow. Never delete a distinct phrase.
- "transcription_error": fix an obvious speech-to-text mishearing of a SINGLE word that context makes unambiguous — a proper noun or a homophone, e.g. "Senator Cantwater" -> "Senator Cantwell", "their" -> "there". Change exactly one word, and only when it clearly sounds like the intended word.

You may NEVER:
- Add, substitute, reorder, or remove a substantive word (except filler and verbatim false-starts as defined above).
- Rephrase, paraphrase, summarize, "improve" grammar, expand contractions, change tense, or change any number, quantity, or date.
- Change the meaning of a sentence in any way.
- Fix a grammatical error made by the speaker if doing so changes the words spoken. A speaker's grammatical error is part of the record — for example, leave "there's three reasons" exactly as spoken.
- Fix or complete a sentence the speaker left unfinished. Trailing off or being cut off is part of the record; never add words to finish the thought.

"original" MUST be copied exactly from the turn text (same characters), so it can be located. If you cannot copy it exactly, do not propose that edit. If a turn needs no edits, return an empty edits array for it. Output ONLY the structured JSON described by the schema.`;

/**
 * Build the { system, userText } pair for one batch of consecutive turns.
 * @param batch [{ index, text }]  index is the turn's position within THIS batch
 */
function buildPrompt({ batch }) {
  const body = batch.map((t) => `[#${t.index}]\n${t.text}`).join('\n\n');
  const userText =
`TURNS TO EDIT — each block is one transcript turn, prefixed with its index.
The same rules apply to every turn. Propose edits per turn by index.

${body}

Return an entry for every turn index above (empty edits array if a turn needs none).`;
  return { system: SYSTEM, userText };
}

module.exports = { buildPrompt, CLEANUP_SCHEMA };
