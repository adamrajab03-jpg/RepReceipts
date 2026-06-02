import { useState } from 'react'
import { useHearings } from '../hooks/useHearings'
import HearingCard from '../components/HearingCard'

const STATUSES = [
  { label: 'All',       value: '' },
  { label: 'Published', value: 'published' },
  { label: 'Scheduled', value: 'scheduled' },
  { label: 'Live',      value: 'live' },
]

export default function HearingsPage() {
  const [status, setStatus] = useState('')

  const { data, isLoading, isError } = useHearings({
    status: status || undefined,
  })

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Hearings</h1>

      <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm mb-6 w-fit">
        {STATUSES.map(s => (
          <button
            key={s.value}
            onClick={() => setStatus(s.value)}
            className={`px-3 py-2 transition-colors ${
              status === s.value
                ? 'bg-slate-800 text-white'
                : 'bg-white text-gray-700 hover:bg-gray-50'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {isError   && <p className="text-sm text-red-500">Failed to load hearings.</p>}

      {data && (
        <>
          <p className="text-xs text-gray-400 mb-3">
            {data.count} hearing{data.count !== 1 ? 's' : ''}
          </p>
          {data.count === 0 ? (
            <p className="text-sm text-gray-500">No hearings match your filters.</p>
          ) : (
            <div className="space-y-3">
              {data.data.map(h => <HearingCard key={h.id} hearing={h} />)}
            </div>
          )}
        </>
      )}
    </div>
  )
}
