import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../utils/apiFetch'
import type { Comment, CommentNode, VoteResult } from '../types/api'

export type CommentScope =
  | { type: 'turn';    id: string }
  | { type: 'hearing'; id: string }

function scopeKey(scope: CommentScope) {
  return ['comments', scope.type, scope.id]
}

function scopeUrl(scope: CommentScope) {
  return scope.type === 'turn'
    ? `/api/turns/${scope.id}/comments`
    : `/api/hearings/${scope.id}/comments`
}

// ── Fetch ─────────────────────────────────────────────────────────────────────
export function useComments(scope: CommentScope, enabled = true) {
  return useQuery({
    queryKey: scopeKey(scope),
    queryFn: async () => {
      const res = await fetch(scopeUrl(scope))
      if (!res.ok) throw new Error('Failed to fetch comments')
      const { data } = await res.json()
      return data as Comment[]
    },
    staleTime: 30_000,
    enabled,
  })
}

// ── Build tree ────────────────────────────────────────────────────────────────
export function buildTree(flat: Comment[]): CommentNode[] {
  const map = new Map(flat.map(c => [c.id, { ...c, children: [] as CommentNode[] }]))
  const roots: CommentNode[] = []
  for (const node of map.values()) {
    if (node.parent_id) {
      map.get(node.parent_id)?.children.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

// ── Create comment ────────────────────────────────────────────────────────────
export interface CreateCommentInput {
  scope:     CommentScope
  body:      string
  parent_id?: string
  quote?: { char_start: number; char_end: number; quoted_text: string }
}

export function useCreateComment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ scope, body, parent_id, quote }: CreateCommentInput) => {
      const res = await apiFetch(scopeUrl(scope), {
        method: 'POST',
        body: JSON.stringify({ body, parent_id, quote }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to post comment')
      return data.data as Comment
    },
    onSuccess: (_comment, { scope }) => {
      qc.invalidateQueries({ queryKey: scopeKey(scope) })
    },
  })
}

// ── Vote ──────────────────────────────────────────────────────────────────────
export interface VoteInput {
  commentId: string
  value:     1 | -1
  scope:     CommentScope
}

export function useVoteComment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ commentId, value }: VoteInput) => {
      const res = await apiFetch(`/api/comments/${commentId}/vote`, {
        method: 'POST',
        body: JSON.stringify({ value }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to vote')
      return data.data as VoteResult
    },

    onMutate: async ({ commentId, value, scope }) => {
      const key = scopeKey(scope)
      await qc.cancelQueries({ queryKey: key })
      const snapshot = qc.getQueryData<Comment[]>(key)

      qc.setQueryData<Comment[]>(key, old =>
        old?.map(c => {
          if (c.id !== commentId) return c
          const prev = c.user_vote
          let newVote: -1 | 1 | null
          let delta: number
          if (prev === value)   { newVote = null;  delta = -value }
          else if (prev != null){ newVote = value; delta = value - prev }
          else                  { newVote = value; delta = value }
          return { ...c, score: c.score + delta, user_vote: newVote }
        })
      )
      return { snapshot }
    },

    onError: (_err, { scope }, ctx) => {
      if (ctx?.snapshot) qc.setQueryData(scopeKey(scope), ctx.snapshot)
    },

    onSettled: (_data, _err, { scope }) => {
      qc.invalidateQueries({ queryKey: scopeKey(scope) })
    },
  })
}

// ── Delete (soft) ─────────────────────────────────────────────────────────────
export interface DeleteCommentInput {
  commentId: string
  scope:     CommentScope
}

export function useDeleteComment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ commentId }: DeleteCommentInput) => {
      const res = await apiFetch(`/api/comments/${commentId}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed to delete comment')
      return data.data as { id: string; is_deleted: true }
    },

    onMutate: async ({ commentId, scope }) => {
      const key = scopeKey(scope)
      await qc.cancelQueries({ queryKey: key })
      const snapshot = qc.getQueryData<Comment[]>(key)

      qc.setQueryData<Comment[]>(key, old =>
        old?.map(c =>
          c.id === commentId
            ? {
                ...c,
                body: '[deleted]',
                is_deleted: true,
                quoted_text: null,
                char_start: null,
                char_end: null,
                user_vote: null,
              }
            : c
        )
      )
      return { snapshot }
    },

    onError: (_err, { scope }, ctx) => {
      if (ctx?.snapshot) qc.setQueryData(scopeKey(scope), ctx.snapshot)
    },

    onSettled: (_data, _err, { scope }) => {
      qc.invalidateQueries({ queryKey: scopeKey(scope) })
    },
  })
}
