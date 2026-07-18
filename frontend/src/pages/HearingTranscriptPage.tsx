import { Link, useParams } from 'react-router-dom'
import { useHearingTranscript } from '../hooks/useHearingTranscript'
import TranscriptView from '../components/TranscriptView'
import CommentThread from '../components/CommentThread'
import { tierBadge, tierBanner } from '../utils/hearingTier'
import { cn } from '../utils/cn'

function fmtDate(iso: string | null) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  })
}

export default function HearingTranscriptPage() {
  const { id } = useParams<{ id: string }>()
  const { data, isLoading, isError } = useHearingTranscript(id!)

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (isError || !data) return <p className="text-sm text-red-500">Hearing not found.</p>

  const { hearing, transcript } = data.data
  const badge = tierBadge(hearing.status)
  const banner = tierBanner(hearing.status)

  return (
    <div>
      <Link to="/hearings" className="text-sm text-gray-500 hover:text-gray-700 mb-4 inline-block">
        ← Back to Hearings
      </Link>

      {/* Hearing header */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-xl font-bold text-gray-900 leading-snug">{hearing.title}</h1>
          <span className={cn('text-xs font-medium px-2 py-1 rounded-full shrink-0', badge.cls)}>
            {badge.label}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-sm text-gray-500">
          {hearing.committee_name && <span>{hearing.committee_name}</span>}
          {hearing.held_on        && <span>{fmtDate(hearing.held_on)}</span>}
          {hearing.congress       && <span>{hearing.congress}th Congress</span>}
        </div>
      </div>

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
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-lg font-semibold text-gray-800">Transcript</h2>
            <span className="text-xs text-gray-400 capitalize">
              {transcript.source.replace(/_/g, ' ')} · {transcript.status}
            </span>
            <span className="text-xs text-gray-400">
              {transcript.turns.length} turn{transcript.turns.length !== 1 ? 's' : ''}
            </span>
          </div>
          <TranscriptView transcript={transcript} />
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
  )
}
