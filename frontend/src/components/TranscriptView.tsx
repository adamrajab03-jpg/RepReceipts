import { useMemo } from 'react'
import type { Transcript } from '../types/api'
import SpeakerTurn from './SpeakerTurn'
import TranscriptOutline, { TranscriptOutlineBar } from './TranscriptOutline'
import { PhaseHeading, SectionHeading } from './TranscriptHeadings'
import { useActiveAnchor } from '../hooks/useActiveAnchor'
import { groupIntoPhases, layoutHeaders, sectionAnchorId } from '../utils/sectionPhases'
import { youtubeWatchAt } from '../utils/youtube'
import { cn } from '../utils/cn'

/**
 * The public reading view: a sticky outline that follows the reader, and the
 * transcript itself set as a document — sans-serif scaffolding (phase headers,
 * section headers, speaker labels, timecodes) around serif testimony.
 *
 * Everything structural is DERIVED from the flat section list at render time
 * (see utils/sectionPhases), so re-sectioning in the admin workbench changes
 * what readers see here without any data migration.
 */
export default function TranscriptView({ transcript, videoUrl }: {
  transcript: Transcript
  videoUrl?: string | null
}) {
  const sections = transcript.sections ?? []

  // Big phase headers are derived by grouping consecutive same-phase sections;
  // 'unassigned' is admin bookkeeping, so readers never see it — those turns
  // simply flow without a header.
  const groups = useMemo(() => groupIntoPhases(sections, { includeUnassigned: false }), [sections])
  const headers = useMemo(
    () => layoutHeaders(transcript.turns, sections, { includeUnassigned: false }),
    [transcript.turns, sections],
  )

  // A section's start time is the start of the turn its header actually lands
  // on. Taking it from the header (rather than from the section's stored start
  // turn) keeps the video timestamp honest on the public page, which hides
  // blank admin-inserted turns and so may begin a section one turn later.
  const startMsOf = useMemo(() => {
    const m = new Map<string, number | null>()
    for (const turn of transcript.turns) {
      for (const slot of headers.get(turn.id) ?? []) m.set(slot.section.id, turn.start_ms)
    }
    return m
  }, [headers, transcript.turns])

  const sectionAnchors = useMemo(
    () => groups.flatMap((g) => g.sections.map((s) => sectionAnchorId(s.id))),
    [groups],
  )
  const active = useActiveAnchor(sectionAnchors)

  if (!transcript.turns.length) {
    return (
      <p className="text-sm text-gray-500 py-12 text-center">
        No speaker turns recorded yet.
      </p>
    )
  }

  const outline = {
    groups,
    timeOf: (id: string) => startMsOf.get(id) ?? null,
    active,
  }

  return (
    <div>
      {/* Mobile position indicator + drawer. Lives outside the grid so its
          sticky containing block spans the whole transcript. */}
      <TranscriptOutlineBar {...outline} />

      {/* Two columns only when there is an outline to put in the first one — an
          unsectioned hearing reads full width instead of against a blank gutter.
          `items-start` is what lets the sidebar be sticky: without it the grid
          stretches the cell to full height and there is nowhere to travel. */}
      <div className={cn(groups.length && 'lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-8 lg:items-start')}>
        <TranscriptOutline {...outline} />

        <article className="rounded-lg border border-gray-200 bg-white px-5 pb-8 sm:px-10">
          {transcript.turns.map((turn, i) => {
            const slots = headers.get(turn.id)
            return (
              <div key={turn.id}>
                {slots?.map(({ phase, section }) => {
                  const startMs = startMsOf.get(section.id) ?? null
                  const watchHref = youtubeWatchAt(videoUrl, startMs)
                  return (
                    <div key={section.id}>
                      {phase && (
                        <PhaseHeading
                          group={phase}
                          index={groups.indexOf(phase)}
                          startMs={startMs}
                          watchHref={watchHref}
                        />
                      )}
                      <SectionHeading
                        section={section}
                        startMs={startMs}
                        watchHref={watchHref}
                        opensPhase={!!phase}
                      />
                    </div>
                  )
                })}
                <SpeakerTurn turn={turn} index={i} startsSection={!!slots?.length} />
              </div>
            )
          })}
        </article>
      </div>
    </div>
  )
}
