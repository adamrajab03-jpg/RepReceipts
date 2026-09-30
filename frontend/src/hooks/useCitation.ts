import { useQuery } from '@tanstack/react-query'
import type { CitationView, DetailResponse } from '../types/api'
import { apiFetch } from '../utils/apiFetch'

async function fetchCitation(code: string): Promise<DetailResponse<CitationView>> {
  const res = await fetch(`/api/citations/${encodeURIComponent(code)}`)
  if (!res.ok) throw new Error(res.status === 404 ? 'not_found' : 'Failed to load quote')
  return res.json()
}

/** A shared quote and where it is in the current transcript. Resolved fresh on
 *  every load — never cached across sessions — so a later edit always shows. */
export function useCitation(code: string) {
  return useQuery({
    queryKey: ['citation', code],
    queryFn: () => fetchCitation(code),
    enabled: !!code,
    retry: false,
  })
}

export interface NewCitation {
  code: string
  url: string
  quoted_text: string
  created: boolean
}

/**
 * Create (or re-use) the citation for a selection. Only the turn and range go
 * up — plus the text the reader saw, so the server can refuse if the turn
 * changed under them. Throws an Error carrying the server's message.
 */
export async function createCitation(input: {
  turn_id: string
  char_start: number
  char_end: number
  expected_text: string
}): Promise<NewCitation> {
  const res = await apiFetch('/api/citations', { method: 'POST', body: JSON.stringify(input) })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? 'Could not create a link')
  return body.data as NewCitation
}

/** Absolute share URL for a citation code. */
export const citationUrl = (code: string) => `${window.location.origin}/q/${code}`
