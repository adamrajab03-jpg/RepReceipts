import { useQuery } from '@tanstack/react-query'
import type { ListResponse, Member } from '../types/api'

interface MembersFilter {
  chamber?: string
  party?: string
  state?: string
  search?: string
}

async function fetchMembers(filters: MembersFilter): Promise<ListResponse<Member>> {
  const params = new URLSearchParams()
  Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v) })
  const res = await fetch(`/api/members?${params}`)
  if (!res.ok) throw new Error('Failed to fetch members')
  return res.json()
}

export function useMembers(filters: MembersFilter = {}) {
  return useQuery({
    queryKey: ['members', filters],
    queryFn: () => fetchMembers(filters),
  })
}
