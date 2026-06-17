import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../utils/apiFetch'
import { useAuthStore } from '../store/authStore'
import type {
  FollowsState, MemberFollow, TopicFollow, RepTopicFollow,
} from '../types/api'

// The three follow shapes. 'rep_topic' carries both member_id and topic_id.
export type FollowKind = 'member' | 'topic' | 'rep_topic'

const KEY = ['follows']
const EMPTY: FollowsState = { members: [], topics: [], repTopics: [] }

// ── Fetch the current user's follows (three groups) ───────────────────────────
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

// ── Convenience selectors ─────────────────────────────────────────────────────
export function useIsFollowing(type: 'member' | 'topic', id: string): boolean {
  const { data } = useFollows()
  if (!data) return false
  return type === 'member'
    ? data.members.some(m => m.id === id)
    : data.topics.some(t => t.id === id)
}

export function useIsFollowingRepTopic(memberId: string, topicId: string): boolean {
  const { data } = useFollows()
  if (!data) return false
  return data.repTopics.some(r => r.member_id === memberId && r.topic_id === topicId)
}

// ── Mutation inputs ───────────────────────────────────────────────────────────
// `display` is the optimistic row pushed into the matching group before refetch.
export type FollowInput =
  | { kind: 'member';    member_id: string; display: MemberFollow }
  | { kind: 'topic';     topic_id: string;  display: TopicFollow }
  | { kind: 'rep_topic'; member_id: string; topic_id: string; display: RepTopicFollow }

export type UnfollowInput =
  | { kind: 'member';    member_id: string }
  | { kind: 'topic';     topic_id: string }
  | { kind: 'rep_topic'; member_id: string; topic_id: string }

function bodyFor(v: FollowInput | UnfollowInput): Record<string, string> {
  switch (v.kind) {
    case 'member':    return { member_id: v.member_id }
    case 'topic':     return { topic_id: v.topic_id }
    case 'rep_topic': return { member_id: v.member_id, topic_id: v.topic_id }
  }
}

export function useFollow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (v: FollowInput) => {
      const res = await apiFetch('/api/follows', { method: 'POST', body: JSON.stringify(bodyFor(v)) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to follow')
      return data.data
    },
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: KEY })
      const snapshot = qc.getQueryData<FollowsState>(KEY)
      qc.setQueryData<FollowsState>(KEY, old => {
        const base = old ?? EMPTY
        if (v.kind === 'member') {
          if (base.members.some(m => m.id === v.member_id)) return base
          return { ...base, members: [...base.members, v.display] }
        }
        if (v.kind === 'topic') {
          if (base.topics.some(t => t.id === v.topic_id)) return base
          return { ...base, topics: [...base.topics, v.display] }
        }
        if (base.repTopics.some(r => r.member_id === v.member_id && r.topic_id === v.topic_id)) return base
        return { ...base, repTopics: [...base.repTopics, v.display] }
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
    mutationFn: async (v: UnfollowInput) => {
      const res = await apiFetch('/api/follows', { method: 'DELETE', body: JSON.stringify(bodyFor(v)) })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to unfollow')
      return data.data
    },
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: KEY })
      const snapshot = qc.getQueryData<FollowsState>(KEY)
      qc.setQueryData<FollowsState>(KEY, old => {
        if (!old) return old
        if (v.kind === 'member') return { ...old, members: old.members.filter(m => m.id !== v.member_id) }
        if (v.kind === 'topic')  return { ...old, topics: old.topics.filter(t => t.id !== v.topic_id) }
        return {
          ...old,
          repTopics: old.repTopics.filter(r => !(r.member_id === v.member_id && r.topic_id === v.topic_id)),
        }
      })
      return { snapshot }
    },
    onError: (_e, _v, ctx) => { if (ctx?.snapshot) qc.setQueryData(KEY, ctx.snapshot) },
    onSettled: () => { qc.invalidateQueries({ queryKey: KEY }) },
  })
}
