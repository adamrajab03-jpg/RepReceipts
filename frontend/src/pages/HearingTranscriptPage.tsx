import { Link, useParams } from 'react-router-dom'
import { useHearingTranscript } from '../hooks/useHearingTranscript'
import TranscriptView from '../components/TranscriptView'
import { cn } from '../utils/cn'

const STATUS_STYLES: Record<string, string> = {
  scheduled:  'bg-yellow-100 text-yellow-700',
  live:       'bg-green-100 text-green-700',
  processing: 'bg-blue-100 text-blue-700',
  published:  'bg-slate-100 text-slate-600',
}

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

  return (
    <div>
      <Link to="/hearings" className="text-sm text-gray-500 hover:text-gray-700 mb-4 inline-block">
        ← Back to Hearings
      </Link>

      {/* Hearing header */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-xl font-bold text-gray-900 leading-snug">{hearing.title}</h1>
          <span className={cn(
            'text-xs font-medium px-2 py-1 rounded-full shrink-0 capitalize',
            STATUS_STYLES[hearing.status] ?? STATUS_STYLES.published
          )}>
            {hearing.status}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-sm text-gray-500">
          {hearing.committee_name && <span>{hearing.committee_name}</span>}
          {hearing.held_on        && <span>{fmtDate(hearing.held_on)}</span>}
          {hearing.congress       && <span>{hearing.congress}th Congress</span>}
        </div>
      </div>

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
    </div>
  )
}
