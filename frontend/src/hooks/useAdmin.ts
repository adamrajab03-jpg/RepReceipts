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

// ── Manual inline text edit (Part A) ────────────────────────────────────────
export function useEditTurnText(hearingId: string) {
  const invalidate = useInvalidate(hearingId)
  return useMutation({
    // `base` is the cleaned text the editor was opened on. The server composes
    // the change onto the existing edit stack relative to it, and 409s if an
    // edit was accepted/dismissed meanwhile rather than diffing a stale baseline.
    mutationFn: async ({ turnId, text, base }: { turnId: string; text: string; base: string }): Promise<Demotable & { edits: number }> => {
      const res = await apiFetch(`/api/admin/hearings/${hearingId}/turns/${turnId}/text`, {
        method: 'POST',
        body: JSON.stringify({ text, base }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Text edit failed')
      return body.data
    },
    onSuccess: invalidate,
  })
}

// ── Mark a turn's text reviewed with no change ("looks good") ────────────────
export function useReviewTurnText(hearingId: string) {
  const invalidate = useInvalidate(hearingId)
  return useMutation({
    mutationFn: async ({ turnId }: { turnId: string }): Promise<{ reviewed: boolean }> => {
      const res = await apiFetch(`/api/admin/hearings/${hearingId}/turns/${turnId}/text-review`, { method: 'POST' })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Mark-reviewed failed')
      return body.data
    },
    onSuccess: invalidate,
  })
}

// ── Accept an LLM cleanup proposal (re-validated server-side at accept time) ─
export type AcceptCleanupVars = { turnId: string } & ({ edit_id: string } | { all_safe: true })
export function useAcceptCleanup(hearingId: string) {
  const invalidate = useInvalidate(hearingId)
  return useMutation({
    mutationFn: async ({ turnId, ...payload }: AcceptCleanupVars): Promise<Demotable & { accepted: number }> => {
      const res = await apiFetch(`/api/admin/hearings/${hearingId}/turns/${turnId}/cleanup/accept`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Accept failed')
      return body.data
    },
    onSuccess: invalidate,
  })
}

// ── Dismiss cleanup proposals — recoverable, never a hard delete ─────────────
// One edit, or every still-pending edit on the turn. Dismissed suggestions keep
// living in suggestions.cleanup (status 'rejected') and can be restored.
export type RejectCleanupVars = { turnId: string } & ({ edit_id: string } | { all_pending: true })
export function useRejectCleanup(hearingId: string) {
  const invalidate = useInvalidate(hearingId)
  return useMutation({
    mutationFn: async ({ turnId, ...payload }: RejectCleanupVars): Promise<Demotable & { dismissed: number }> => {
      const res = await apiFetch(`/api/admin/hearings/${hearingId}/turns/${turnId}/cleanup/reject`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Dismiss failed')
      return body.data
    },
    onSuccess: invalidate,
  })
}

// ── Apply a BLOCKED suggestion's text as the admin's own human edit ─────────
// Never produces an llm edit: the validator blocked the change as a meaning
// change, so the human who overrides that block owns the result (violet).
export function useOverrideCleanup(hearingId: string) {
  const invalidate = useInvalidate(hearingId)
  return useMutation({
    mutationFn: async ({ turnId, edit_id }: { turnId: string; edit_id: string }): Promise<Demotable & { applied: number }> => {
      const res = await apiFetch(`/api/admin/hearings/${hearingId}/turns/${turnId}/cleanup/override`, {
        method: 'POST',
        body: JSON.stringify({ edit_id }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Override failed')
      return body.data
    },
    onSuccess: invalidate,
  })
}

// ── Undo a dismissal — puts the suggestion back in the pending queue ─────────
export function useRestoreCleanup(hearingId: string) {
  const invalidate = useInvalidate(hearingId)
  return useMutation({
    mutationFn: async ({ turnId, edit_id }: { turnId: string; edit_id: string }): Promise<Demotable & { restored: number }> => {
      const res = await apiFetch(`/api/admin/hearings/${hearingId}/turns/${turnId}/cleanup/restore`, {
        method: 'POST',
        body: JSON.stringify({ edit_id }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Restore failed')
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
