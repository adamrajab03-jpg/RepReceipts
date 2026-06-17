import { useSearchParams } from 'react-router-dom'
import { useHearings } from '../hooks/useHearings'
import { useTopics } from '../hooks/useTopics'
import { useMember } from '../hooks/useMember'
import HearingCard from '../components/HearingCard'
import FollowButton from '../components/FollowButton'

const STATUSES = [
  { label: 'All',       value: '' },
  { label: 'Published', value: 'published' },
  { label: 'Scheduled', value: 'scheduled' },
  { label: 'Live',      value: 'live' },
]

export default function HearingsPage() {
  const [params, setParams] = useSearchParams()
  const status = params.get('status') ?? ''
  const topic  = params.get('topic')  ?? ''
  const member = params.get('member') ?? ''

  const topicsQ = useTopics()
  const memberQ = useMember(member)

  // Resolve the active topic slug to its {id, name} via the topics tree.
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
                  type="topic"
                  variant="star"
                  display={{ id: selectedTopic.id, slug: selectedTopic.slug, name: selectedTopic.name }}
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
