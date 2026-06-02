import { useQuery } from '@tanstack/react-query'
import type { ListResponse, Hearing } from '../types/api'

interface HearingsFilter {
  committee_id?: string
  status?: string
  congress?: string
}

async function fetchHearings(filters: HearingsFilter): Promise<ListResponse<Hearing>> {
  const params = new URLSearchParams()
  Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v) })
  const res = await fetch(`/api/hearings?${params}`)
  if (!res.ok) throw new Error('Failed to fetch hearings')
  return res.json()
}

export function useHearings(filters: HearingsFilter = {}) {
  return useQuery({
    queryKey: ['hearings', filters],
    queryFn: () => fetchHearings(filters),
  })
}
