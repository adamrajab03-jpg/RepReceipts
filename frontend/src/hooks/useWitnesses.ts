import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../utils/apiFetch'
import type { DetailResponse, WitnessEditorData, WitnessRow } from '../types/api'

/** What the PUT accepts: the editable half of a row, in display order. */
export type WitnessInput = Pick<
  WitnessRow,
  'id' | 'speaker_name' | 'display_name' | 'title' | 'organization' | 'industry' | 'industry_custom'
>

export function useWitnesses(hearingId: string) {
  return useQuery({
    queryKey: ['admin', 'witnesses', hearingId],
    queryFn: async (): Promise<WitnessEditorData> => {
      const res = await fetch(`/api/admin/hearings/${hearingId}/witnesses`)
      if (!res.ok) throw new Error('Failed to load witnesses')
      const body: DetailResponse<WitnessEditorData> = await res.json()
      return body.data
    },
    enabled: !!hearingId,
    // The editor holds a form. A background refetch would replace rows the
    // admin is halfway through typing, so this query only refreshes when
    // something explicitly invalidates it.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  })
}

/**
 * One atomic full-set save: array order is display order, rows dropped from the
 * array are deleted, rows without an id are inserted. Writes the response
 * straight into the cache — the server returns the same shape as the GET, so the
 * editor re-renders from server truth (fresh ids, recomputed link_state) rather
 * than from what it hoped happened.
 */
export function useSaveWitnesses(hearingId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (witnesses: WitnessInput[]): Promise<WitnessEditorData> => {
      const res = await apiFetch(`/api/admin/hearings/${hearingId}/witnesses`, {
        method: 'PUT',
        body: JSON.stringify({ witnesses }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? 'Failed to save witnesses')
      return body.data
    },
    onSuccess: (data) => {
      qc.setQueryData(['admin', 'witnesses', hearingId], data)
      // The public page reads witnesses out of the transcript payload, so it is
      // stale the moment this succeeds.
      qc.invalidateQueries({ queryKey: ['hearing-transcript', hearingId] })
    },
  })
}

/**
 * Rename a witness IN THE TRANSCRIPT, by routing through the existing
 * attribution endpoint — once per diarization bucket carrying the old name.
 *
 * This is the ONLY way this feature touches speaker_turns, and it does so
 * through the one code path that already owns those writes: applySpeaker sets
 * speaker_role, recomputes attribution_status, and demotes a 'verified' hearing
 * back to 'attributed'. `demoted` is surfaced so the editor can say so.
 */
export function useRenameInTranscript(hearingId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ speakerKeys, name }: { speakerKeys: string[]; name: string }) => {
      let demoted = false
      for (const speaker_key of speakerKeys) {
        const res = await apiFetch(`/api/admin/hearings/${hearingId}/speakers`, {
          method: 'PATCH',
          body: JSON.stringify({ speaker_key, decision: 'witness', witness_name: name }),
        })
        const body = await res.json()
        if (!res.ok) throw new Error(body.error ?? 'Failed to rename in transcript')
        demoted = demoted || !!body.data?.demoted
      }
      return { demoted }
    },
    onSuccess: () => {
      // The turns changed, so every view of them is stale: the witness editor's
      // own link_state, the review workbench, and the public transcript.
      qc.invalidateQueries({ queryKey: ['admin', 'witnesses', hearingId] })
      qc.invalidateQueries({ queryKey: ['admin', 'review', hearingId] })
      qc.invalidateQueries({ queryKey: ['admin', 'hearings'] })
      qc.invalidateQueries({ queryKey: ['hearing-transcript', hearingId] })
    },
  })
}
