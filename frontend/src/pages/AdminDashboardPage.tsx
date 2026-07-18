import { Link } from 'react-router-dom'
import { useAdminHearings } from '../hooks/useAdmin'
import type { AdminHearing } from '../types/api'
import { cn } from '../utils/cn'

const STATUS_STYLES: Record<string, string> = {
  transcribing: 'bg-blue-100 text-blue-700',
  draft:        'bg-amber-100 text-amber-700',
  attributed:   'bg-blue-100 text-blue-800',
  verified:     'bg-green-100 text-green-800',
  published:    'bg-green-100 text-green-700',
  scheduled:    'bg-slate-100 text-slate-600',
}

function ReviewProgress({ h }: { h: AdminHearing }) {
  if (!h.speaker_count) return <span className="text-gray-400">no speakers</span>
  const done = h.pending_count === 0
  return (
    <span className={done ? 'text-green-700' : 'text-amber-700'}>
      {h.reviewed_count} / {h.speaker_count} speakers reviewed
      {h.pending_count > 0 && ` · ${h.pending_count} pending`}
    </span>
  )
}

export default function AdminDashboardPage() {
  const { data: hearings, isLoading, error } = useAdminHearings()

  if (isLoading) return <div className="py-16 text-center text-sm text-gray-400">Loading…</div>
  if (error) return <div className="py-16 text-center text-sm text-red-600">Failed to load.</div>

  return (
    <div>
      <h1 className="text-2xl font-bold text-slate-900 mb-1">Attribution review</h1>
      <p className="text-sm text-gray-500 mb-6">Confirm auto-generated speaker attributions, then publish.</p>

      <div className="bg-white rounded-xl border border-gray-200 divide-y divide-gray-100">
        {(hearings ?? []).map((h) => (
          <div key={h.id} className="flex items-center gap-4 px-5 py-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={cn('text-xs px-2 py-0.5 rounded-full capitalize', STATUS_STYLES[h.status] ?? 'bg-gray-100 text-gray-600')}>
                  {h.status}
                </span>
                <span className="font-medium text-slate-800 truncate">{h.title}</span>
              </div>
              <div className="mt-1 text-xs text-gray-500">
                {h.committee_name ?? 'No committee'} · {h.turn_count} turns · <ReviewProgress h={h} />
              </div>
            </div>
            <Link
              to={`/admin/hearings/${h.id}/review`}
              className="shrink-0 text-sm font-medium px-3 py-1.5 rounded-lg bg-slate-800 text-white hover:bg-slate-700 transition-colors"
            >
              Review
            </Link>
          </div>
        ))}
        {!hearings?.length && (
          <div className="px-5 py-8 text-center text-sm text-gray-400">No hearings yet.</div>
        )}
      </div>
    </div>
  )
}
