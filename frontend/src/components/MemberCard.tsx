import { Link } from 'react-router-dom'
import type { Member } from '../types/api'
import { cn } from '../utils/cn'

function partyBadge(party: string | null) {
  if (party === 'D') return 'bg-blue-100 text-blue-700'
  if (party === 'R') return 'bg-red-100 text-red-700'
  return 'bg-gray-100 text-gray-600'
}

function locationLabel(m: Member) {
  if (!m.state) return null
  return m.district ? `${m.state}-${m.district}` : m.state
}

export default function MemberCard({ member: m }: { member: Member }) {
  return (
    <Link
      to={`/members/${m.id}`}
      className="block bg-white rounded-lg border border-gray-200 p-4 hover:border-slate-400 hover:shadow-sm transition-all"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold text-gray-900 text-sm leading-snug">{m.full_name}</h3>
        {m.party && (
          <span className={cn('text-xs font-bold px-2 py-0.5 rounded-full shrink-0', partyBadge(m.party))}>
            {m.party}
          </span>
        )}
      </div>
      <p className="text-xs text-gray-500 mt-1 capitalize">
        {m.member_type}{locationLabel(m) ? ` · ${locationLabel(m)}` : ''}
      </p>
      {m.committees.length > 0 && (
        <p className="text-xs text-gray-400 mt-2 truncate">
          {m.committees[0].committee_name}
          {m.committees[0].role !== 'member' && (
            <span className="ml-1 capitalize">({m.committees[0].role.replace('_', ' ')})</span>
          )}
        </p>
      )}
    </Link>
  )
}
