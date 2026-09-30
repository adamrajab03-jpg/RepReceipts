import { Link, useParams } from 'react-router-dom'
import { useHearingTranscript } from '../hooks/useHearingTranscript'
import TranscriptView from '../components/TranscriptView'
import HearingContextHeader from '../components/HearingContextHeader'
import HearingWitnesses from '../components/HearingWitnesses'
import { shouldGroupWitnesses } from '../utils/witnessGroups'
import CommentThread from '../components/CommentThread'
import { tierBanner } from '../utils/hearingTier'
import { youtubeWatchAt } from '../utils/youtube'
import { cn } from '../utils/cn'
import { HearingVideoProvider, useHearingVideo } from '../components/HearingVideo'
import { CitationNotFound, CitationVideoCue } from '../components/CitationReceipt'
import type { CitationView } from '../types/api'

export default function HearingTranscriptPage({ hearingId, citation }: {
  /** Given by CitationPage (/q/:code); otherwise the :id route param. */
  hearingId?: string
  /** A shared quote this page was opened for. */
  citation?: CitationView
} = {}) {
  const params = useParams<{ id: string }>()
  const id = hearingId ?? params.id
  const { data, isLoading, isError } = useHearingTranscript(id!)

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (isError || !data) return <p className="text-sm text-red-500">Hearing not found.</p>

  const { hearing, transcript, context } = data.data
  const banner = tierBanner(hearing.status)
  // One decision, two components: when witness records exist the grouped
  // section owns them, and the header drops its compact row so the same three
  // people are not listed twice.
  const grouped = shouldGroupWitnesses(context.witnesses)
  // Null unless the hearing has a usable YouTube URL (/live/, /watch?v=, youtu.be).
  const watchFromStart = youtubeWatchAt(hearing.video_url, 0)

  // A shared quote counts as located only if every segment the resolver found
  // is a turn this page actually rendered. (The two requests are separate; if
  // the transcript changed between them, show the receipt rather than a
  // highlight that might land on the wrong words.)
  const located = !!citation && citation.resolution.status !== 'not_found' &&
    !!transcript && citation.resolution.segments.length > 0 &&
    citation.resolution.segments.every((s) => transcript.turns.some((t) => t.id === s.turn_id))

  return (
    // One docked player for the page: the sidebar hosts it, and every "▶ Watch"
    // (headers, outline, "Watch the full hearing") seeks it.
    <HearingVideoProvider videoUrl={hearing.video_url}>
    <div>
      <Link to="/hearings" className="text-sm text-gray-500 hover:text-gray-700 mb-4 inline-block">
        ← Back to Hearings
      </Link>

      {/* A shared quote: park the player at its moment (no autoplay). When the
          passage can't be located, the receipt itself leads the page — it is
          what the reader came for, and there is no highlight to scroll to. */}
      {citation && <CitationVideoCue seekMs={citation.citation.seek_ms} />}
      {citation && !located && <CitationNotFound view={citation} videoUrl={hearing.video_url} />}

      {/* Hearing identity + reading context (committee, members, topics, and
          witnesses too when no records have been entered yet) */}
      <HearingContextHeader hearing={hearing} context={context} showWitnesses={!grouped} />

      {/* Who testified, grouped industry → organization → witness. Renders only
          once an admin has filled in records; sits with the other context, above
          the trust banner, so the banner stays the last thing before the words. */}
      <HearingWitnesses witnesses={context.witnesses} />

      {/* Trust-tier banner — the reader-facing signal above the quotes.
          draft (raw) · attributed (AI-assisted) · verified (human-verified). */}
      {banner && (
        <div className={cn('border text-sm rounded-lg px-4 py-3 mb-6 flex items-start gap-3', banner.cls)}>
          <span className="text-lg leading-none shrink-0" aria-hidden>{banner.icon}</span>
          <span>
            <span className="font-semibold">{banner.title}.</span>{' '}
            {banner.body}
          </span>
        </div>
      )}

      {/* Transcript */}
      {!transcript ? (
        <p className="text-sm text-gray-500 py-12 text-center">
          No transcript available yet.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-4">
            <h2 className="text-lg font-semibold text-gray-800">Transcript</h2>
            <span className="text-xs text-gray-400 capitalize">
              {transcript.source.replace(/_/g, ' ')} · {transcript.status}
            </span>
            <span className="text-xs text-gray-400">
              {transcript.turns.length} turn{transcript.turns.length !== 1 ? 's' : ''}
            </span>
            {watchFromStart && (
              <WatchFullHearing href={watchFromStart} />
            )}
          </div>
          <TranscriptView transcript={transcript} videoUrl={hearing.video_url} citation={located ? citation : null} />
        </>
      )}

      {/* Hearing-level discussion — not tied to any specific turn */}
      <div className="mt-8">
        <h2 className="text-lg font-semibold text-gray-800 mb-3">Discussion</h2>
        <div className="bg-white rounded-lg border border-gray-200 p-5">
          <CommentThread
            scope={{ type: 'hearing', id: id! }}
            defaultCollapsed={false}
          />
        </div>
      </div>
    </div>
    </HearingVideoProvider>
  )
}

/** "Watch the full hearing" — plays the docked player from the top, or opens YouTube without one. */
function WatchFullHearing({ href }: { href: string }) {
  const { canSeek, seekClick } = useHearingVideo()
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={seekClick(0)}
      title={canSeek ? 'Play the hearing from the start' : 'Open the hearing video on YouTube'}
      className="ml-auto inline-flex items-baseline gap-1 text-xs text-slate-500 transition-colors hover:text-slate-900"
    >
      <span aria-hidden className="text-[9px]">▶</span>
      Watch the full hearing
    </a>
  )
}
