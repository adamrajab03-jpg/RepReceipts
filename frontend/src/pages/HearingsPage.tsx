import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useHearings } from '../hooks/useHearings'
import { useTopics } from '../hooks/useTopics'
import { useMember } from '../hooks/useMember'
import HearingCard from '../components/HearingCard'
import FollowButton from '../components/FollowButton'
import type { Hearing } from '../types/api'

const STATUSES = [
  { label: 'All',            value: '' },
  { label: 'Scheduled',      value: 'scheduled' },
  { label: 'AI-attributed',  value: 'attributed' },
  { label: 'Human-verified', value: 'verified' },
]

type CommitteeGroup = {
  name: string
  scheduled: Hearing[]   // upcoming — ascending by date
  published: Hearing[]   // past     — descending by date
}

function groupByCommittee(hearings: Hearing[]): CommitteeGroup[] {
  const map = new Map<string, CommitteeGroup>()
  for (const h of hearings) {
    const key = h.committee_name ?? 'Other'
    if (!map.has(key)) map.set(key, { name: key, scheduled: [], published: [] })
    const g = map.get(key)!
    if (h.status === 'scheduled' || h.status === 'live') {
      g.scheduled.push(h)
    } else {
      g.published.push(h)
    }
  }
  for (const g of map.values()) {
    g.scheduled.sort((a, b) => (a.held_on ?? '').localeCompare(b.held_on ?? ''))
    g.published.sort((a, b) => (b.held_on ?? '').localeCompare(a.held_on ?? ''))
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export default function HearingsPage() {
  const [params, setParams] = useSearchParams()
  const status = params.get('status') ?? ''
  const topic  = params.get('topic')  ?? ''
  const member = params.get('member') ?? ''

  const topicsQ = useTopics()
  const memberQ = useMember(member)

  const selectedTopic = topic
    ? topicsQ.data?.data.flatMap(a => a.children).find(c => c.slug === topic)
    : undefined

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value); else next.delete(key)
    setParams(next, { replace: true })
  }

  const { data, isLoading, isError } = useHearings({
    status: status || undefined,
    topic:  topic  || undefined,
    member: member || undefined,
  })

  const groups = useMemo(() => groupByCommittee(data?.data ?? []), [data])
  // Whether we're locked to one status bucket (don't need subsection labels)
  const singleStatus = status === 'scheduled' || status === 'live' || status === 'published' || status === 'processing' || status === 'attributed' || status === 'verified'

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Hearings</h1>

      <div className="flex flex-wrap gap-3 items-center mb-6">
        <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm w-fit">
          {STATUSES.map(s => (
            <button
              key={s.value}
              onClick={() => setParam('status', s.value)}
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

        <select
          value={topic}
          onChange={e => setParam('topic', e.target.value)}
          className="text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white"
        >
          <option value="">All topics</option>
          {topicsQ.data?.data.map(area => (
            <optgroup key={area.id} label={area.name}>
              {area.children.map(c => (
                <option key={c.id} value={c.slug}>{c.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      {(topic || member) && (
        <div className="flex flex-wrap gap-2 mb-4 text-xs">
          {topic && (
            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-teal-50 text-teal-700 border border-teal-200">
              Topic: {selectedTopic?.name ?? topic}
              {selectedTopic && (
                <FollowButton
                  kind="topic"
                  variant="star"
                  topic={{ id: selectedTopic.id, slug: selectedTopic.slug, name: selectedTopic.name }}
                />
              )}
              <button
                onClick={() => setParam('topic', '')}
                className="text-teal-500 hover:text-teal-700"
                aria-label="Clear topic filter"
              >✕</button>
            </span>
          )}
          {member && (
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
              Member: {memberQ.data?.data.full_name ?? member}
              <button
                onClick={() => setParam('member', '')}
                className="text-slate-500 hover:text-slate-700"
                aria-label="Clear member filter"
              >✕</button>
            </span>
          )}
        </div>
      )}

      {isLoading && <p className="text-sm text-gray-500">Loading…</p>}
      {isError   && <p className="text-sm text-red-500">Failed to load hearings.</p>}

      {data && (
        <>
          <p className="text-xs text-gray-400 mb-4">
            {data.count} hearing{data.count !== 1 ? 's' : ''}
          </p>

          {data.count === 0 ? (
            <p className="text-sm text-gray-500">No hearings match your filters.</p>
          ) : (
            <div className="space-y-1">
              {groups.map(g => (
                <div key={g.name}>
                  <h2 className="sticky top-0 bg-gray-50/80 backdrop-blur-sm z-10 text-xs font-semibold uppercase tracking-wide text-gray-500 py-2 border-b border-gray-100">
                    {g.name}
                  </h2>
                  <div className="pt-3 pb-6 space-y-6">
                    {/* Scheduled (upcoming) first */}
                    {g.scheduled.length > 0 && (
                      <div>
                        {!singleStatus && g.published.length > 0 && (
                          <p className="text-xs uppercase tracking-wide text-gray-400 mb-2">Scheduled</p>
                        )}
                        <div className="space-y-3">
                          {g.scheduled.map(h => <HearingCard key={h.id} hearing={h} />)}
                        </div>
                      </div>
                    )}
                    {/* Past hearings second */}
                    {g.published.length > 0 && (
                      <div>
                        {!singleStatus && g.scheduled.length > 0 && (
                          <p className="text-xs uppercase tracking-wide text-gray-400 mb-2">Past hearings</p>
                        )}
                        <div className="space-y-3">
                          {g.published.map(h => <HearingCard key={h.id} hearing={h} />)}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
