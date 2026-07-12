// ============================================================================
//  Attribution prompt construction (the crux — kept isolated so it's reviewable
//  and tunable without touching the provider or CLI).
// ----------------------------------------------------------------------------
//  Strategy: send the FULL transcript (every diarized turn, with its raw
//  "Speaker N" label) plus the committee roster as the bounded candidate list,
//  and have the model reason over the WHOLE speaker structure at once — one
//  call maps every distinct Speaker N. The model returns each member by
//  bioguide_id (never a UUID); the CLI validates that against the exact roster
//  that was sent and coerces anything unrecognized to "unknown".
// ============================================================================

// JSON schema for structured outputs (output_config.format). Structured-outputs
// schemas can't express numeric ranges, so `confidence` is a plain number and
// the 0..1 clamp happens in code (anthropicProvider.js).
const ATTRIBUTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    speakers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          speaker_label: { type: 'string' },                         // "Speaker 3"
          identity_type: { type: 'string', enum: ['member', 'witness', 'unknown'] },
          bioguide_id:   { type: ['string', 'null'] },               // set only for members, from the roster
          display_name:  { type: ['string', 'null'] },               // resolved name (member or witness)
          confidence:    { type: 'number' },                         // 0..1 (validated in code)
          reasoning:     { type: 'string' },                         // cites the specific cue
        },
        required: ['speaker_label', 'identity_type', 'bioguide_id', 'display_name', 'confidence', 'reasoning'],
      },
    },
  },
  required: ['speakers'],
};

const ROLE_LABEL = { chair: 'CHAIR', ranking_member: 'RANKING MEMBER', member: 'member' };
const ROLE_RANK = { chair: 0, ranking_member: 1, member: 2 };

const SYSTEM = `You are an expert analyst of United States congressional hearing transcripts. Your job is to map each anonymous, auto-diarized speaker label (e.g. "Speaker 3") to a real identity: a specific member of the committee, a named witness, or "unknown".

You reason over the WHOLE transcript at once. A given "Speaker N" is the same person every time it appears, so use cues from anywhere in the transcript to identify them.

Identities you may assign:
- A committee member — identified by their bioguide_id from the roster provided. ONLY use a bioguide_id that appears in the roster; never invent one.
- A witness — a named person who is NOT on the roster (e.g. an expert testifying). Put their name in display_name and leave bioguide_id null.
- unknown — when the transcript lacks enough cues to identify the speaker confidently. This is always a valid, expected answer. Do NOT guess without a cue.

Verbal cues to use:
- Chair control: "the committee will come to order", "the chair recognizes...", "without objection" → the CHAIR (flagged in the roster).
- Ranking member: "I yield to the ranking member", "the ranking member is recognized" → the RANKING MEMBER (flagged in the roster).
- State references: "the senator from Washington", "the gentleman from Texas" → match the roster member from that state.
- Direct address: "Thank you, Senator Cantwell", "As Senator Cruz noted..." → names a person who is often a DIFFERENT speaker than the one currently talking.
- Witness recognition: "we'll now recognize Mr. Kimmelman", "Ms. Osei, you may begin" → identifies the witness who speaks.
- Self-introduction: "I'm Senator X", "My name is ...".

CRITICAL — the identifying cue often lives in a DIFFERENT turn than the speaker it identifies. When one speaker INTRODUCES or RECOGNIZES another ("The chair recognizes Senator Blackburn", "we'll now hear from Mr. Davis"), the person named is usually the speaker of the FOLLOWING turn, not the introducer. Connect the introduction to the SUBSEQUENT speaker. Example: if [Speaker 1] says "The chair recognizes Senator Blackburn" and [Speaker 4] speaks next, then Speaker 4 is likely Blackburn — and Speaker 1, doing the recognizing, is likely the chair.

For every speaker give a confidence in [0, 1] and a one-sentence reasoning that quotes the specific cue phrase that justifies the identification (or, for unknown, says what was missing).

Map every distinct speaker label present in the transcript exactly once. Output ONLY the structured JSON described by the schema.`;

/**
 * Build the { system, userText } pair for one hearing.
 *
 * @param hearingMeta    { title, committeeName, thomasId, heldOn }
 * @param roster         [{ bioguideId, fullName, party, state, role }]  (role: chair|ranking_member|member)
 * @param transcriptTurns[{ label, text }]  in seq order
 * @param speakerLabels  ordered distinct labels to map
 */
function buildPrompt({ hearingMeta, roster, transcriptTurns, speakerLabels }) {
  const rosterRows = [...roster]
    .sort((a, b) =>
      (ROLE_RANK[a.role] ?? 9) - (ROLE_RANK[b.role] ?? 9) ||
      a.fullName.localeCompare(b.fullName))
    .map((m) =>
      `${m.bioguideId} | ${m.fullName} | ${m.party ?? '?'} | ${m.state ?? '?'} | ${ROLE_LABEL[m.role] ?? 'member'}`)
    .join('\n');

  const transcript = transcriptTurns
    .map((t) => `[${t.label}] ${t.text}`)
    .join('\n');

  const userText =
`HEARING
Title: ${hearingMeta.title}
Committee: ${hearingMeta.committeeName} (thomas_id ${hearingMeta.thomasId})
Date: ${hearingMeta.heldOn || 'unknown'}

COMMITTEE ROSTER — the bounded candidate list of members
bioguide_id | name | party | state | role
${rosterRows}
(Named witnesses are NOT in this roster — infer them from the transcript.)

TRANSCRIPT — each line is one diarized turn; the same "Speaker N" is the same person throughout.
${transcript}

SPEAKER LABELS TO MAP (map each of these exactly once): ${speakerLabels.join(', ')}`;

  return { system: SYSTEM, userText };
}

module.exports = { buildPrompt, ATTRIBUTION_SCHEMA };
