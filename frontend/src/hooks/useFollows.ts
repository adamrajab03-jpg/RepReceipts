import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../utils/apiFetch'
import { useAuthStore } from '../store/authStore'
import type { FollowsState } from '../types/api'

export type FollowType = 'member' | 'topic'

const KEY = ['follows']

// ── Fetch the current user's follows (members + topics) ───────────────────────
export function useFollows() {
  const user = useAuthStore(s => s.user)
  return useQuery({
    queryKey: KEY,
    queryFn: async () => {
      const res = await fetch('/api/follows')
      if (!res.ok) throw new Error('Failed to fetch follows')
      const { data } = (await res.json()) as { data: FollowsState }
      return data
    },
    enabled: !!user,
    staleTime: 60_000,
  })
}

// Convenience: is a given member/topic currently followed?
export function useIsFollowing(type: FollowType, id: string): boolean {
  const { data } = useFollows()
  if (!data) return false
  return type === 'member'
    ? data.members.some(m => m.id === id)
    : data.topics.some(t => t.id === id)
}

export interface FollowInput {
  type: FollowType
  id: string
  // Minimal display row so the optimistic update can render before refetch.
  display: FollowsState['members'][number] | FollowsState['topics'][number]
}

export function useFollow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ type, id }: FollowInput) => {
      const body = type === 'member' ? { member_id: id } : { topic_id: id }
      const res = await apiFetch('/api/follows', { method: 'POST', body: JSON.stringify(body) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to follow')
      return data.data
    },
    onMutate: async ({ type, id, display }) => {
      await qc.cancelQueries({ queryKey: KEY })
      const snapshot = qc.getQueryData<FollowsState>(KEY)
      qc.setQueryData<FollowsState>(KEY, old => {
        const base = old ?? { members: [], topics: [] }
        if (type === 'member') {
          if (base.members.some(m => m.id === id)) return base
          return { ...base, members: [...base.members, display as FollowsState['members'][number]] }
        }
        if (base.topics.some(t => t.id === id)) return base
        return { ...base, topics: [...base.topics, display as FollowsState['topics'][number]] }
      })
      return { snapshot }
    },
    onError: (_e, _v, ctx) => { if (ctx?.snapshot) qc.setQueryData(KEY, ctx.snapshot) },
    onSettled: () => { qc.invalidateQueries({ queryKey: KEY }) },
  })
}

export function useUnfollow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ type, id }: { type: FollowType; id: string }) => {
      const res = await apiFetch(`/api/follows/${type}/${id}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to unfollow')
      return data.data
    },
    onMutate: async ({ type, id }) => {
      await qc.cancelQueries({ queryKey: KEY })
      const snapshot = qc.getQueryData<FollowsState>(KEY)
      qc.setQueryData<FollowsState>(KEY, old => {
        if (!old) return old
        return type === 'member'
          ? { ...old, members: old.members.filter(m => m.id !== id) }
          : { ...old, topics: old.topics.filter(t => t.id !== id) }
      })
      return { snapshot }
    },
    onError: (_e, _v, ctx) => { if (ctx?.snapshot) qc.setQueryData(KEY, ctx.snapshot) },
    onSettled: () => { qc.invalidateQueries({ queryKey: KEY }) },
  })
}
