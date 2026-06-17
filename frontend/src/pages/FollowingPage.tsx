import { Link } from 'react-router-dom'
import { useFollows, useUnfollow } from '../hooks/useFollows'
import { useAuthStore } from '../store/authStore'

const PARTY_LABEL: Record<string, string> = { D: 'Democrat', R: 'Republican', I: 'Independent' }

function meta(party: string | null, state: string | null): string {
  return [party && (PARTY_LABEL[party] ?? party), state].filter(Boolean).join(' · ')
}

export default function FollowingPage() {
  const user = useAuthStore(s => s.user)
  const { data, isLoading, isError } = useFollows()
  const unfollow = useUnfollow()

  if (!user) return <p className="text-sm text-gray-500">Sign in to manage who you follow.</p>
  if (isLoading) return <p className="text-sm text-gray-500">Loading…</p>
  if (isError || !data) return <p className="text-sm text-red-500">Couldn’t load your follows.</p>

  const empty =
    data.members.length === 0 && data.topics.length === 0 && data.repTopics.length === 0

  return (
    <div className="max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Following</h1>

      {empty && (
        <p className="text-sm text-gray-500">
          You aren’t following anyone yet. Follow a representative or a topic to get notified about new activity.
        </p>
      )}

      {data.members.length > 0 && (
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-gray-800 mb-3">Representatives</h2>
          <div className="space-y-2">
            {data.members.map(m => (
              <div key={m.id} className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex items-center justify-between gap-3">
                <Link to={`/members/${m.id}`} className="text-sm font-medium text-slate-800 hover:text-teal-700">
                  {m.full_name}
                  <span className="ml-2 text-xs text-gray-400">{meta(m.party, m.state)}</span>
                </Link>
                <button
                  onClick={() => unfollow.mutate({ kind: 'member', member_id: m.id })}
                  disabled={unfollow.isPending}
                  className="text-xs text-gray-400 hover:text-red-600 transition-colors disabled:opacity-50"
                >
                  Unfollow
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.topics.length > 0 && (
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-gray-800 mb-3">Topics</h2>
          <div className="space-y-2">
            {data.topics.map(t => (
              <div key={t.id} className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex items-center justify-between gap-3">
                <Link to={`/hearings?topic=${t.slug}`} className="text-sm font-medium text-teal-700 hover:underline">
                  {t.name}
                </Link>
                <button
                  onClick={() => unfollow.mutate({ kind: 'topic', topic_id: t.id })}
                  disabled={unfollow.isPending}
                  className="text-xs text-gray-400 hover:text-red-600 transition-colors disabled:opacity-50"
                >
                  Unfollow
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.repTopics.length > 0 && (
        <section>
          <h2 className="text-lg font-semibold text-gray-800 mb-3">Reps + Topics</h2>
          <div className="space-y-2">
            {data.repTopics.map(r => (
              <div
                key={`${r.member_id}:${r.topic_id}`}
                className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex items-center justify-between gap-3"
              >
                <div className="text-sm">
                  <Link to={`/members/${r.member_id}`} className="font-medium text-slate-800 hover:text-teal-700">
                    {r.member_full_name}
                  </Link>
                  <span className="text-gray-400"> on </span>
                  <Link to={`/hearings?topic=${r.topic_slug}&member=${r.member_id}`} className="font-medium text-violet-700 hover:underline">
                    {r.topic_name}
                  </Link>
                </div>
                <button
                  onClick={() => unfollow.mutate({ kind: 'rep_topic', member_id: r.member_id, topic_id: r.topic_id })}
                  disabled={unfollow.isPending}
                  className="text-xs text-gray-400 hover:text-red-600 transition-colors disabled:opacity-50"
                >
                  Unfollow
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
