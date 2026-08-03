// ============================================================================
//  Anthropic (Claude) cleanup provider — mirrors attribution/anthropicProvider.
// ----------------------------------------------------------------------------
//  One Messages call per batch with structured outputs. Reads ANTHROPIC_API_KEY
//  from the same root .env as the rest of the pipeline. Parses + shape-
//  normalizes only; span location, content-word validation, and all DB writes
//  are the CLI's provider-agnostic job (cleanup.js).
//
//  Sonnet 5 — parity with the attribution stage and lower cost on this higher-
//  volume, per-turn pass. The independent validator is what makes cleanup safe,
//  so model choice here is cost/quality, not trust.
// ============================================================================

const Anthropic = require('@anthropic-ai/sdk');
const { buildPrompt, CLEANUP_SCHEMA } = require('./prompt');

const MODEL = 'claude-sonnet-5';

// Standard Sonnet 5 pricing ($/million tokens); intro pricing is ~half through
// 2026-08-31. We report the conservative standard figure.
const USD_PER_MTOK_INPUT = 3.0;
const USD_PER_MTOK_OUTPUT = 15.0;

function createAnthropicProvider() {
  async function cleanupBatch({ batch }) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set in the root .env');

    const client = new Anthropic({ apiKey });
    const { system, userText } = buildPrompt({ batch });

    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,                 // headroom for adaptive thinking + the (small) edit JSON
      system,
      messages: [{ role: 'user', content: userText }],
      output_config: { format: { type: 'json_schema', schema: CLEANUP_SCHEMA } },
    });

    if (res.stop_reason === 'refusal') {
      throw new Error('Model refused the request (stop_reason: refusal).');
    }
    if (res.stop_reason === 'max_tokens') {
      throw new Error('Model hit max_tokens before finishing — output truncated. Lower --batch or raise max_tokens.');
    }

    const textBlock = res.content.find((b) => b.type === 'text');
    if (!textBlock) throw new Error('Model returned no text block to parse.');

    let parsed;
    try {
      parsed = JSON.parse(textBlock.text);
    } catch (err) {
      throw new Error(`Model output was not valid JSON: ${err.message}`);
    }

    // Normalize shape ONLY. Do NOT trim original/replacement — whitespace is
    // significant for locating the span and for exact reconstruction.
    const rawTurns = (parsed.turns || []).map((t) => ({
      turnIndex: Number(t.turn_index),
      edits: (t.edits || []).map((e) => ({
        original: String(e.original ?? ''),
        replacement: String(e.replacement ?? ''),
        llmType: e.type,
      })),
    }));

    const u = res.usage || {};
    const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const outTok = u.output_tokens || 0;
    const costUsd = (inTok / 1e6) * USD_PER_MTOK_INPUT + (outTok / 1e6) * USD_PER_MTOK_OUTPUT;

    return { rawTurns, usage: { inputTokens: inTok, outputTokens: outTok }, costUsd, model: MODEL, provider: 'anthropic' };
  }

  return { name: 'anthropic', cleanupBatch };
}

module.exports = { createAnthropicProvider };
