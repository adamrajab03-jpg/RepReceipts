// ============================================================================
//  Content-addressed cache for raw Deepgram batch responses.
// ----------------------------------------------------------------------------
//  Keyed by computeSourceKey() (sha256 of the audio bytes or source URL, see
//  deepgram.js) — not by hearing — so a re-ingest of the exact same audio is
//  a $0, instant cache hit even after the hearing that first used it has been
//  deleted and recreated.
// ============================================================================

const fs = require('fs');
const path = require('path');

const ARTIFACTS_DIR = path.resolve(__dirname, 'artifacts');

function cachePath(sourceKey) {
  return path.join(ARTIFACTS_DIR, `${sourceKey}.json`);
}

function readCache(sourceKey) {
  const file = cachePath(sourceKey);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeCache(sourceKey, data) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.writeFileSync(cachePath(sourceKey), JSON.stringify(data, null, 2));
}

module.exports = { readCache, writeCache };
