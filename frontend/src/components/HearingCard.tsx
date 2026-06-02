import { Link } from 'react-router-dom'
import type { Hearing } from '../types/api'
import { cn } from '../utils/cn'

const statusStyles: Record<string, string> = {
  scheduled:  'bg-yellow-100 text-yellow-700',
  live:       'bg-green-100 text-green-700',
  processing: 'bg-blue-100 text-blue-700',
  published:  'bg-slate-100 text-slate-600',
}

function fmtDate(iso: string | null) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function HearingCard({ hearing: h }: { hearing: Hearing }) {
  return (
    <Link
      to={`/hearings/${h.id}`}
      className="block bg-white rounded-lg border border-gray-200 p-4 hover:border-slate-400 hover:shadow-sm transition-all"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-semibold text-gray-900 text-sm leading-snug">{h.title}</h3>
        <span className={cn('text-xs font-medium px-2 py-0.5 rounded-full shrink-0 capitalize',
          statusStyles[h.status] ?? statusStyles.published)}>
          {h.status}
        </span>
      </div>
      {h.committee_name && (
        <p className="text-xs text-gray-500 mt-1">{h.committee_name}</p>
      )}
      <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
        {h.held_on && <span>{fmtDate(h.held_on)}</span>}
        {h.congress && <span>119th Congress</span>}
      </div>
    </Link>
  )
}
