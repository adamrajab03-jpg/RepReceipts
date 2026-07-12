// ============================================================================
//  Attribution provider contract + factory (the swappable seam).
// ----------------------------------------------------------------------------
//  A provider maps anonymous diarized speakers to real identities:
//
//    attributeSpeakers({ hearingMeta, roster, transcriptTurns, speakerLabels })
//      → {
//          rawMappings: [{ speakerLabel, identityType, bioguideId,
//                          displayName, confidence, reasoning }],
//          usage: { inputTokens, outputTokens },
//          costUsd, model, provider
//        }
//
//  The Claude implementation is the only one today. A future local/OSS model
//  (e.g. Llama via Ollama) drops in as another module implementing the same
//  attributeSpeakers signature; select it here by name (attribute.js --provider).
// ============================================================================

const { createAnthropicProvider } = require('./anthropicProvider');

function getProvider(name = 'anthropic') {
  switch (name) {
    case 'anthropic':
      return createAnthropicProvider();
    default:
      throw new Error(`Unknown attribution provider: ${name}`);
  }
}

module.exports = { getProvider };
