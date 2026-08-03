// ============================================================================
//  Cleanup provider contract + factory (the swappable seam) — mirrors
//  attribution/provider.js.
// ----------------------------------------------------------------------------
//  A provider proposes grammar-cleanup edits for a batch of turns:
//
//    cleanupBatch({ batch })   // batch: [{ index, text }]
//      → {
//          rawTurns: [{ turnIndex, edits: [{ original, replacement, llmType }] }],
//          usage: { inputTokens, outputTokens },
//          costUsd, model, provider
//        }
//
//  The provider only parses/shape-normalizes model output. It does NOT locate
//  spans, classify edits, or touch the DB — those provider-agnostic steps live
//  in cleanup.js (locate/validate) so they apply uniformly to any future
//  provider (e.g. a local model).
// ============================================================================

const { createAnthropicProvider } = require('./anthropicProvider');

function getProvider(name = 'anthropic') {
  switch (name) {
    case 'anthropic':
      return createAnthropicProvider();
    default:
      throw new Error(`Unknown cleanup provider: ${name}`);
  }
}

module.exports = { getProvider };
