import { useAuthStore } from '../store/authStore'
import {
  useIsFollowing, useFollow, useUnfollow, type FollowType,
} from '../hooks/useFollows'
import type { FollowsState } from '../types/api'
import { cn } from '../utils/cn'

type Display =
  | FollowsState['members'][number]
  | FollowsState['topics'][number]

interface FollowButtonProps {
  type: FollowType
  display: Display          // row inserted optimistically; display.id is the target
  variant?: 'button' | 'star'
}

export default function FollowButton({ type, display, variant = 'button' }: FollowButtonProps) {
  const user      = useAuthStore(s => s.user)
  const following = useIsFollowing(type, display.id)
  const follow    = useFollow()
  const unfollow  = useUnfollow()

  if (!user) return null

  const pending = follow.isPending || unfollow.isPending
  const toggle = () => {
    if (pending) return
    if (following) unfollow.mutate({ type, id: display.id })
    else           follow.mutate({ type, id: display.id, display })
  }

  if (variant === 'star') {
    return (
      <button
        onClick={toggle}
        disabled={pending}
        aria-pressed={following}
        title={following ? 'Following — click to unfollow' : 'Follow'}
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
