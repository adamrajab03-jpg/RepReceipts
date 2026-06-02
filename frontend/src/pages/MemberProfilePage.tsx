import { Link, useParams } from 'react-router-dom'
import { useMember } from '../hooks/useMember'
import { cn } from '../utils/cn'

const ROLE_LABEL: Record<string, string> = {
  chair:          'Chair',
  ranking_member: 'Ranking Member',
  member:         'Member',
}

const PARTY_LABEL: Record<string, string> = {
  D: 'Democrat',
  R: 'Republican',
  I: 'Independent',
}

export default function MemberProfilePage() {
  const { id } = useParams<{ id: string }>()
  const { data, isLoading, isError } = useMember(id!)

  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (isError || !data) return <p className="text-sm text-red-500">Member not found.</p>

  const m = data.data

  return (
    <div className="max-w-2xl">
      <Link to="/members" className="text-sm text-gray-500 hover:text-gray-700 mb-4 inline-block">
        ← Back to Members
      </Link>

      <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{m.full_name}</h1>
            <p className="text-gray-500 mt-1 capitalize">
              {m.member_type}
              {m.state && ` · ${m.state}`}
              {m.district != null && `-${m.district}`}
            </p>
          </div>
          {m.party && (
            <span className={cn(
              'text-sm font-bold px-3 py-1 rounded-full shrink-0',
              m.party === 'D' ? 'bg-blue-100 text-blue-700' :
              m.party === 'R' ? 'bg-red-100 text-red-700' :
              'bg-gray-100 text-gray-600'
            )}>
              {PARTY_LABEL[m.party] ?? m.party}
            </span>
          )}
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
          <div>
            <dt className="text-gray-400 text-xs uppercase tracking-wide">Chamber</dt>
            <dd className="font-medium capitalize mt-0.5">{m.chamber ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-gray-400 text-xs uppercase tracking-wide">Status</dt>
            <dd className="font-medium mt-0.5">{m.is_current ? 'Current' : 'Former'}</dd>
          </div>
          {m.bioguide_id && (
            <div>
              <dt className="text-gray-400 text-xs uppercase tracking-wide">Bioguide ID</dt>
              <dd className="font-mono text-xs mt-0.5">{m.bioguide_id}</dd>
            </div>
          )}
        </dl>
      </div>

      {m.committees.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold text-gray-800 mb-3">Committee Memberships</h2>
          <div className="space-y-2">
            {m.committees.map((c, i) => (
              <div
                key={i}
                className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex items-center justify-between gap-3"
              >
                <span className="text-sm text-gray-800">{c.committee_name}</span>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-gray-400">{c.congress}th Congress</span>
                  <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full">
                    {ROLE_LABEL[c.role] ?? c.role}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
