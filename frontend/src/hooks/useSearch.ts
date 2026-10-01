import { useQuery } from '@tanstack/react-query'
import type { SearchResponse } from '../types/api'

export interface SearchParams {
  q?: string
  /** m:<member-uuid> or w:<hearing_witness-uuid> */
  speaker?: string
  committee?: string
  party?: string
  date_from?: string
  date_to?: string
  hearing?: string
  sort?: string
  page?: number
}

async function fetchSearch(p: SearchParams): Promise<SearchResponse> {
  const params = new URLSearchParams()
  Object.entries(p).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v))
  })
  const res = await fetch(`/api/search?${params}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error((body as { error?: string }).error ?? 'Search failed')
  }
  return res.json()
}

/**
 * `enabled` gates the request — pass false when there's nothing to search
 * (no query and no filter), so we don't fire a 400 on an empty page.
 */
export function useSearch(p: SearchParams, enabled: boolean) {
  return useQuery({
    queryKey: ['search', p],
    queryFn: () => fetchSearch(p),
    enabled,
    placeholderData: (prev) => prev, // keep the last page visible while paging
  })
}
