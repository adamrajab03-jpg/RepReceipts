import { useMemo } from 'react'
import type { Transcript } from '../types/api'
import SpeakerTurn from './SpeakerTurn'
import SectionNav from './SectionNav'
import PhaseHeader from './PhaseHeader'
import { groupIntoPhases, layoutHeaders, sectionAnchorId, sectionTitle } from '../utils/sectionPhases'

export default function TranscriptView({ transcript }: { transcript: Transcript }) {
  const sections = transcript.sections ?? []

  // Big phase headers are derived by grouping consecutive same-phase sections;
  // 'unassigned' is admin bookkeeping, so readers never see it — those turns
  // simply flow without a header.
  const groups = useMemo(() => groupIntoPhases(sections, { includeUnassigned: false }), [sections])
  const headers = useMemo(
    () => layoutHeaders(transcript.turns, sections, { includeUnassigned: false }),
    [transcript.turns, sections],
  )

  if (!transcript.turns.length) {
    return (
      <p className="text-sm text-gray-500 py-12 text-center">
        No speaker turns recorded yet.
      </p>
    )
  }

  return (
    <div>
      {groups.length > 0 && <SectionNav groups={groups} className="mb-4" />}

      <div className="rounded-lg border border-gray-200 overflow-hidden divide-y divide-gray-100">
        {transcript.turns.map((turn, i) => {
          const slots = headers.get(turn.id)
          return (
            <div key={turn.id}>
              {slots?.map(({ phase, section }, si) => (
                <div key={section.id} className="bg-white px-4">
                  {phase && <PhaseHeader group={phase} index={groups.indexOf(phase)} />}
                  <h3
                    id={sectionAnchorId(section.id)}
                    className="scroll-mt-24 pt-3 pb-1.5 text-sm font-semibold text-slate-700"
                  >
                    {sectionTitle(section)}
                    <span className="ml-2 text-xs font-normal text-gray-400 tabular-nums">
                      turns {section.start_seq}–{section.end_seq}
                    </span>
                  </h3>
                  {si === (slots.length - 1) && <div className="border-b border-gray-100" />}
                </div>
              ))}
              <SpeakerTurn turn={turn} index={i} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
