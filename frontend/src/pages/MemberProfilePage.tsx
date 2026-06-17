import { Link, useParams } from 'react-router-dom'
import { useMember } from '../hooks/useMember'
import { useMemberTopics } from '../hooks/useTopics'
import ApprovalGrid from '../components/ApprovalGrid'
import FollowButton from '../components/FollowButton'
import { cn } from '../utils/cn'
import type { MemberTopic } from '../types/api'

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

function groupByParent(topics: MemberTopic[]) {
  const groups = new Map<string, { name: string; items: MemberTopic[] }>()
  for (const t of topics) {
    const key = t.parent_id ?? t.id
    const name = t.parent_name ?? t.name
    if (!groups.has(key)) groups.set(key, { name, items: [] })
    groups.get(key)!.items.push(t)
  }
  return Array.from(groups.values())
}

export default function MemberProfilePage() {
  const { id } = useParams<{ id: string }>()
  const { data, isLoading, isError } = useMember(id!)
  const topicsQ = useMemberTopics(id!)

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
          <div className="flex flex-col items-end gap-2 shrink-0">
            {m.party && (
              <span className={cn(
                'text-sm font-bold px-3 py-1 rounded-full',
                m.party === 'D' ? 'bg-blue-100 text-blue-700' :
                m.party === 'R' ? 'bg-red-100 text-red-700' :
                'bg-gray-100 text-gray-600'
              )}>
                {PARTY_LABEL[m.party] ?? m.party}
              </span>
            )}
            <FollowButton
              type="member"
              display={{ id: m.id, full_name: m.full_name, party: m.party, state: m.state, chamber: m.chamber }}
            />
          </div>
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
        <div className="mb-6">
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

      <div className="mb-6">
        <h2 className="text-lg font-semibold text-gray-800 mb-3">Approval ratings</h2>
        <ApprovalGrid memberId={m.id} />
      </div>

      <div>
        <h2 className="text-lg font-semibold text-gray-800 mb-3">Topics spoken on</h2>
        {topicsQ.isLoading && <p className="text-sm text-gray-500">Loading…</p>}
        {topicsQ.data && topicsQ.data.count === 0 && (
          <p className="text-sm text-gray-500">No tagged turns yet.</p>
        )}
        {topicsQ.data && topicsQ.data.count > 0 && (
          <div className="space-y-3">
            {groupByParent(topicsQ.data.data).map(g => (
              <div key={g.name}>
                <p className="text-xs uppercase tracking-wide text-gray-400 mb-1.5">{g.name}</p>
                <div className="flex flex-wrap gap-1.5">
                  {g.items.map(t => (
                    <span
                      key={t.id}
                      className="inline-flex items-center gap-1 text-xs pl-2 pr-1.5 py-0.5 rounded-full bg-teal-50 text-teal-700 border border-teal-200"
                    >
                      <Link
                        to={`/hearings?topic=${t.slug}&member=${m.id}`}
                        className="hover:underline"
                      >
                        {t.name}
                        <span className="ml-1 text-teal-500">· {t.turn_count}</span>
                      </Link>
                      <FollowButton type="topic" variant="star" display={{ id: t.id, slug: t.slug, name: t.name }} />
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
