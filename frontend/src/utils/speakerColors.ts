// Assigns a stable color to each *effective identity* in a transcript
// (member_id ?? speaker_name ?? speaker_label_raw), in order of first appearance.
// Coloring by effective identity means a drifted turn shows a wrong color mid-
// block, and correcting it recolors to match its true speaker's block.
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

interface HasIdentity {
  member_id: string | null
  speaker_name: string | null
  speaker_label_raw: string
}

const keyOf = (t: HasIdentity) => t.member_id ?? t.speaker_name ?? t.speaker_label_raw

export function makeSpeakerColors(turns: HasIdentity[]): (t: HasIdentity) => string {
  const map = new Map<string, string>()
  let i = 0
  for (const t of turns) {
    const k = keyOf(t)
    if (!map.has(k)) { map.set(k, PALETTE[i % PALETTE.length]); i++ }
  }
  return (t: HasIdentity) => map.get(keyOf(t)) ?? PALETTE[0]
}
