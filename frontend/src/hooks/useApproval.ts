import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../utils/apiFetch'
import type { DetailResponse, MemberApproval, ApprovalCell, ApprovalHeatmap } from '../types/api'

const key = (memberId: string) => ['member-approval', memberId]

// ── Cross-member heat map ───────────────────────────────────────────────────
export function useApprovalHeatmap() {
  return useQuery({
    queryKey: ['approval-heatmap'],
    queryFn: async () => {
      const res = await fetch('/api/approval/heatmap')
      if (!res.ok) throw new Error('Failed to fetch heat map')
      const { data } = (await res.json()) as DetailResponse<ApprovalHeatmap>
      return data
    },
    staleTime: 60_000,
  })
}

// ── Fetch ─────────────────────────────────────────────────────────────────────
export function useMemberApproval(memberId: string) {
  return useQuery({
    queryKey: key(memberId),
    queryFn: async () => {
      const res = await fetch(`/api/members/${memberId}/approval`)
      if (!res.ok) throw new Error('Failed to fetch approval ratings')
      const { data } = (await res.json()) as DetailResponse<MemberApproval>
      return data
    },
    enabled: !!memberId,
    staleTime: 30_000,
  })
}

// ── Toggle the viewer's rating (overall or per-topic) ─────────────────────────
export interface SetApprovalInput {
  memberId: string
  topicId: string | null
  value: 1 | -1
}

// Recompute a cell's counts/percent for one rating change, mirroring the
// server's toggle semantics so the optimistic update matches the response.
function applyVote(cell: ApprovalCell, value: 1 | -1): ApprovalCell {
  const prev = cell.user_vote
  let { up, down } = cell
  let next: 1 | -1 | null
  if (prev === value)      { value === 1 ? up-- : down--; next = null }
  else if (prev === 1)     { up--; down++; next = value }
  else if (prev === -1)    { down--; up++; next = value }
  else                     { value === 1 ? up++ : down++; next = value }
  const total = up + down
  return {
    ...cell, up, down, total,
    percent: total === 0 ? null : Math.round((100 * up) / total),
    user_vote: next,
  }
}

export function useSetApproval() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ memberId, topicId, value }: SetApprovalInput) => {
      const res = await apiFetch(`/api/members/${memberId}/approval`, {
        method: 'PUT',
        body: JSON.stringify({ value, topic_id: topicId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to save rating')
      return data.data as ApprovalCell
    },

    onMutate: async ({ memberId, topicId, value }) => {
      await qc.cancelQueries({ queryKey: key(memberId) })
      const snapshot = qc.getQueryData<MemberApproval>(key(memberId))

      qc.setQueryData<MemberApproval>(key(memberId), old => {
        if (!old) return old
        if (topicId === null) {
          return { ...old, overall: applyVote(old.overall, value) }
        }
        return {
          ...old,
          topics: old.topics.map(t =>
            t.topic_id === topicId ? applyVote(t, value) : t
          ),
        }
      })
      return { snapshot }
    },

    onError: (_err, { memberId }, ctx) => {
      if (ctx?.snapshot) qc.setQueryData(key(memberId), ctx.snapshot)
    },

    onSettled: (_data, _err, { memberId }) => {
      qc.invalidateQueries({ queryKey: key(memberId) })
    },
  })
}
