import type { Transcript } from '../types/api'
import SpeakerTurn from './SpeakerTurn'

export default function TranscriptView({ transcript }: { transcript: Transcript }) {
  if (!transcript.turns.length) {
    return (
      <p className="text-sm text-gray-500 py-12 text-center">
        No speaker turns recorded yet.
      </p>
    )
  }

  return (
    <div className="rounded-lg border border-gray-200 overflow-hidden divide-y divide-gray-100">
      {transcript.turns.map((turn, i) => (
        <SpeakerTurn key={turn.id} turn={turn} index={i} />
      ))}
    </div>
  )
}
