import { useAuthStore } from '../store/authStore'
import {
  useIsFollowing, useIsFollowingRepTopic, useFollow, useUnfollow,
} from '../hooks/useFollows'
import type { MemberFollow, TopicFollow } from '../types/api'
import { cn } from '../utils/cn'

// Three follow shapes. 'member'/'topic' render a button or a star; 'rep_topic'
// (follow a rep scoped to a topic) renders a diamond, visually distinct from the
// bare-topic star so the user knows which they're toggling.
type FollowButtonProps =
  | { kind: 'member'; member: MemberFollow; variant?: 'button' | 'star' }
  | { kind: 'topic'; topic: TopicFollow; variant?: 'button' | 'star' }
  | { kind: 'rep_topic'; member: MemberFollow; topic: TopicFollow }

export default function FollowButton(props: FollowButtonProps) {
  const user     = useAuthStore(s => s.user)
  const follow   = useFollow()
  const unfollow = useUnfollow()

  // Hooks must run unconditionally; compute "following" for every shape.
  const memberId = props.kind === 'member' ? props.member.id
                 : props.kind === 'rep_topic' ? props.member.id : ''
  const topicId  = props.kind === 'topic' ? props.topic.id
                 : props.kind === 'rep_topic' ? props.topic.id : ''
  const followingMember = useIsFollowing('member', memberId)
  const followingTopic  = useIsFollowing('topic', topicId)
  const followingRepTopic = useIsFollowingRepTopic(memberId, topicId)

  if (!user) return null

  const pending = follow.isPending || unfollow.isPending

  // Context label used in tooltips/aria — names exactly what the button follows.
  const contextLabel =
    props.kind === 'topic'     ? props.topic.name :
    props.kind === 'member'    ? props.member.full_name :
    /* rep_topic */              `${props.member.full_name} on ${props.topic.name}`

  const following =
    props.kind === 'member'    ? followingMember :
    props.kind === 'topic'     ? followingTopic  :
                                 followingRepTopic

  const toggle = () => {
    if (pending) return
    if (props.kind === 'member') {
      if (following) unfollow.mutate({ kind: 'member', member_id: props.member.id })
      else           follow.mutate({ kind: 'member', member_id: props.member.id, display: props.member })
    } else if (props.kind === 'topic') {
      if (following) unfollow.mutate({ kind: 'topic', topic_id: props.topic.id })
      else           follow.mutate({ kind: 'topic', topic_id: props.topic.id, display: props.topic })
    } else {
      const { member, topic } = props
      if (following) {
        unfollow.mutate({ kind: 'rep_topic', member_id: member.id, topic_id: topic.id })
      } else {
        follow.mutate({
          kind: 'rep_topic', member_id: member.id, topic_id: topic.id,
          display: {
            member_id: member.id, member_full_name: member.full_name,
            party: member.party, state: member.state,
            topic_id: topic.id, topic_slug: topic.slug, topic_name: topic.name,
          },
        })
      }
    }
  }

  // rep+topic: violet diamond, distinct from the amber bare-topic star.
  if (props.kind === 'rep_topic') {
    return (
      <button
        onClick={toggle}
        disabled={pending}
        aria-pressed={following}
        title={following
          ? `Following ${contextLabel} — click to unfollow`
          : `Follow ${contextLabel}`}
        className={cn(
          'text-xs leading-none transition-colors disabled:opacity-40',
          following ? 'text-violet-600 hover:text-violet-700' : 'text-gray-300 hover:text-violet-500'
        )}
      >
        {following ? '◆' : '◇'}
      </button>
    )
  }

  const variant = props.variant ?? 'button'

  if (variant === 'star') {
    return (
      <button
        onClick={toggle}
        disabled={pending}
        aria-pressed={following}
        title={following ? `Following ${contextLabel} — click to unfollow` : `Follow ${contextLabel}`}
        className={cn(
          'text-xs leading-none transition-colors disabled:opacity-40',
          following ? 'text-amber-500 hover:text-amber-600' : 'text-gray-300 hover:text-amber-500'
        )}
      >
        {following ? '★' : '☆'}
      </button>
    )
  }

  return (
    <button
      onClick={toggle}
      disabled={pending}
      aria-pressed={following}
      aria-label={following ? `Following ${contextLabel}` : `Follow ${contextLabel}`}
      className={cn(
        'text-sm font-medium px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50',
        following
          ? 'bg-white text-slate-700 border-gray-300 hover:border-red-300 hover:text-red-600'
          : 'bg-slate-800 text-white border-slate-800 hover:bg-slate-700'
      )}
    >
      {following ? 'Following' : 'Follow'}
    </button>
  )
}
