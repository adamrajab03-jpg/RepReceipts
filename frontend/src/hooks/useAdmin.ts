import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../utils/apiFetch'
import type { AdminHearing, ReviewData, ListResponse, DetailResponse } from '../types/api'

// ── Dashboard list ──────────────────────────────────────────────────────────
export function useAdminHearings() {
  return useQuery({
    queryKey: ['admin', 'hearings'],
    queryFn: async (): Promise<AdminHearing[]> => {
      const res = await fetch('/api/admin/hearings')
      if (!res.ok) throw new Error('Failed to load admin hearings')
      const body: ListResponse<AdminHearing> = await res.json()
      return body.data
    },
  })
}

// ── Review data (full chronological transcript) ─────────────────────────────
export function useReview(hearingId: string) {
  return useQuery({
    queryKey: ['admin', 'review', hearingId],
    queryFn: async (): Promise<ReviewData> => {
      const res = await fetch(`/api/admin/hearings/${hearingId}/review`)
      if (!res.ok) throw new Error('Failed to load review data')
      const body: DetailResponse<ReviewData> = await res.json()
      return body.data
    },
  })
}

function useInvalidate(hearingId: string) {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: ['admin', 'review', hearingId] })
    qc.invalidateQueries({ queryKey: ['admin', 'hearings'] })
    qc.invalidateQueries({ queryKey: ['hearing-transcript', hearingId] })
  }
}

export interface SpeakerDecision {
  speaker_key: string
  decision: 'member' | 'witness' | 'unknown'
  member_id?: string
  witness_name?: string
}

/** Per-turn move: join an existing bucket, resolve an identity (optionally
 *  forcing a new speaker bucket), or reset to the home bucket. */
export type TurnDecision = { turnId: string } & (
  | { target_speaker_key: string }
  | { decision: 'member'; member_id: string; new_speaker?: boolean }
  | { decision: 'witness'; witness_name: string; new_speaker?: boolean }
  | { decision: 'unknown' }
  | { decision: 'reset' }
)

export interface SplitPayload {
  turnId: string
  word_index: number
  assign:
    | { mode: 'inherit' }
    | { mode: 'existing'; speaker_key: string }
    | { mode: 'new'; decision?: 'member' | 'witness' | 'unknown'; member_id?: string; witness_name?: string }
}

interface Demotable { demoted?: boolean }

// ── Attribute / correct a whole speaker ─────────────────────────────────────
export function useApplySpeaker(hearingId: string) {
  const invalidate = useInvalidate(hearingId)
  return useMutation({
    mutationFn: async (payload: SpeakerDecision): Promise<Demotable> => {
      const res = await apiFetch(`/api/admin/hearings/${hearingId}/speakers`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Failed to apply attribution')
      return body.data
    },
    onSuccess: invalidate,
  })
}

// ── Override a single turn (diarization drift) / reset ──────────────────────
export function useOverrideTurn(hearingId: string) {
  const invalidate = useInvalidate(hearingId)
  return useMutation({
    mutationFn: async ({ turnId, ...payload }: TurnDecision): Promise<Demotable> => {
      const res = await apiFetch(`/api/admin/hearings/${hearingId}/turns/${turnId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Failed to override turn')
      return body.data
    },
    onSuccess: invalidate,
  })
}

// ── Structural edits: split / merge-delete / insert ─────────────────────────
export function useSplitTurn(hearingId: string) {
  const invalidate = useInvalidate(hearingId)
  return useMutation({
    mutationFn: async ({ turnId, ...payload }: SplitPayload): Promise<Demotable & { new_turn_id: string }> => {
      const res = await apiFetch(`/api/admin/hearings/${hearingId}/turns/${turnId}/split`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Split failed')
      return body.data
    },
    onSuccess: invalidate,
  })
}

export function useMergeTurn(hearingId: string) {
  const invalidate = useInvalidate(hearingId)
  return useMutation({
    mutationFn: async ({ turnId, direction }: { turnId: string; direction: 'up' | 'down' }): Promise<Demotable & { word_times_lost: boolean }> => {
      const res = await apiFetch(`/api/admin/hearings/${hearingId}/turns/${turnId}/merge`, {
        method: 'POST',
        body: JSON.stringify({ direction }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Merge failed')
      return body.data
    },
    onSuccess: invalidate,
  })
}

export function useInsertTurn(hearingId: string) {
  const invalidate = useInvalidate(hearingId)
  return useMutation({
    mutationFn: async ({ turnId, position }: { turnId: string; position: 'before' | 'after' }): Promise<Demotable & { new_turn_id: string }> => {
      const res = await apiFetch(`/api/admin/hearings/${hearingId}/turns/${turnId}/insert`, {
        method: 'POST',
        body: JSON.stringify({ position }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Insert failed')
      return body.data
    },
    onSuccess: invalidate,
  })
}

// ── Attribute every pending speaker ─────────────────────────────────────────
export function useAcceptAll(hearingId: string) {
  const invalidate = useInvalidate(hearingId)
  return useMutation({
    mutationFn: async (): Promise<Demotable & { applied_count: number; applied: { label: string; type: string }[]; skipped: { label: string; reason: string }[] }> => {
      const res = await apiFetch(`/api/admin/hearings/${hearingId}/accept-all`, { method: 'POST' })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Bulk attribute failed')
      return body.data
    },
    onSuccess: invalidate,
  })
}

// ── Tier promotion: attributed | verified (hard-gated server-side) ──────────
export function useSetStatus(hearingId: string) {
  const invalidate = useInvalidate(hearingId)
  return useMutation({
    mutationFn: async (status: 'attributed' | 'verified') => {
      const res = await apiFetch(`/api/admin/hearings/${hearingId}/status`, {
        method: 'POST',
        body: JSON.stringify({ status }),
      })
      const body = await res.json()
      if (!res.ok) {
        const err = new Error(body.error ?? 'Promotion failed') as Error & { unresolved?: string[] }
        err.unresolved = body.unresolved
        throw err
      }
      return body.data as { status: 'attributed' | 'verified' }
    },
    onSuccess: invalidate,
  })
}
