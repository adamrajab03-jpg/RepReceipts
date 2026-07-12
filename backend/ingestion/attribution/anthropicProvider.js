// ============================================================================
//  Anthropic (Claude) attribution provider.
// ----------------------------------------------------------------------------
//  First (and currently only) implementation of the attribution provider
//  contract — see provider.js. Reads ANTHROPIC_API_KEY from the SAME root .env
//  as the rest of the pipeline (loaded by the CLI before this runs). One
//  Messages call with structured outputs maps every distinct speaker.
//
//  This provider parses and shape-normalizes the model output; it does NOT
//  resolve bioguide_id → member UUID or validate against the roster — that
//  provider-agnostic safety step lives in attribute.js so it applies uniformly
//  to any future provider.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { buildPrompt, ATTRIBUTION_SCHEMA } = require('./prompt');

// Sonnet 5 — the model the user chose. Adaptive thinking is on by default,
// which we want for reasoning over scattered/cross-turn verbal cues.
const MODEL = 'claude-sonnet-5';

// Standard Sonnet 5 pricing ($/million tokens). Introductory pricing (roughly
// half) runs through 2026-08-31; we report the conservative standard figure.
const USD_PER_MTOK_INPUT = 3.0;
const USD_PER_MTOK_OUTPUT = 15.0;

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

function createAnthropicProvider() {
  async function attributeSpeakers({ hearingMeta, roster, transcriptTurns, speakerLabels }) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set in the root .env');

    const client = new Anthropic({ apiKey });
    const { system, userText } = buildPrompt({ hearingMeta, roster, transcriptTurns, speakerLabels });

    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,                 // headroom for adaptive thinking + the (small) JSON
      system,
      messages: [{ role: 'user', content: userText }],
      output_config: { format: { type: 'json_schema', schema: ATTRIBUTION_SCHEMA } },
    });

    // Guard the non-happy stop reasons before touching content.
    if (res.stop_reason === 'refusal') {
      throw new Error('Model refused the request (stop_reason: refusal).');
    }
    if (res.stop_reason === 'max_tokens') {
      throw new Error('Model hit max_tokens before finishing — output is truncated/invalid. Re-run (or raise max_tokens).');
    }

    const textBlock = res.content.find((b) => b.type === 'text');
    if (!textBlock) throw new Error('Model returned no text block to parse.');

    let parsed;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch (err) {
      throw new Error(`Model output was not valid JSON: ${err.message}`);
    }

    // Normalize field names + clamp confidence. Roster validation / bioguide
    // resolution is the CLI's job (provider-agnostic).
    const rawMappings = (parsed.speakers || []).map((s) => ({
      speakerLabel: String(s.speaker_label ?? '').trim(),
      identityType: s.identity_type,
      bioguideId: s.bioguide_id ?? null,
      displayName: s.display_name ?? null,
      confidence: clamp01(s.confidence),
      reasoning: String(s.reasoning ?? '').trim(),
    }));

    const u = res.usage || {};
    const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const outTok = u.output_tokens || 0;
    const costUsd = (inTok / 1e6) * USD_PER_MTOK_INPUT + (outTok / 1e6) * USD_PER_MTOK_OUTPUT;

    return { rawMappings, usage: { inputTokens: inTok, outputTokens: outTok }, costUsd, model: MODEL, provider: 'anthropic' };
  }

  return { name: 'anthropic', attributeSpeakers };
}

module.exports = { createAnthropicProvider };
