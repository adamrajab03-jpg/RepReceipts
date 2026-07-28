// Assigns a stable color to each speaker BUCKET (speaker_key) in a transcript,
// in order of first appearance. Bucket colors don't shift when a bucket's
// identity is edited; a turn moved between buckets visibly adopts its new
// bucket's color.
//
// Full literal class strings (no interpolation) so Tailwind keeps them.
const PALETTE = [
  'border-l-blue-400 bg-blue-50',
  'border-l-emerald-400 bg-emerald-50',
  'border-l-amber-400 bg-amber-50',
  'border-l-violet-400 bg-violet-50',
  'border-l-rose-400 bg-rose-50',
  'border-l-cyan-400 bg-cyan-50',
  'border-l-lime-400 bg-lime-50',
  'border-l-orange-400 bg-orange-50',
  'border-l-fuchsia-400 bg-fuchsia-50',
  'border-l-teal-400 bg-teal-50',
  'border-l-indigo-400 bg-indigo-50',
  'border-l-pink-400 bg-pink-50',
]

interface HasBucket {
  speaker_key: string
}

export function makeSpeakerColors(turns: HasBucket[]): (t: HasBucket) => string {
  const map = new Map<string, string>()
  let i = 0
  for (const t of turns) {
    if (!map.has(t.speaker_key)) { map.set(t.speaker_key, PALETTE[i % PALETTE.length]); i++ }
  }
  return (t: HasBucket) => map.get(t.speaker_key) ?? PALETTE[0]
}
