import { useQuery } from '@tanstack/react-query'
import type { DetailResponse, MemberDetail } from '../types/api'

async function fetchMember(id: string): Promise<DetailResponse<MemberDetail>> {
  const res = await fetch(`/api/members/${id}`)
  if (!res.ok) throw new Error('Failed to fetch member')
  return res.json()
}

export function useMember(id: string) {
  return useQuery({
    queryKey: ['member', id],
    queryFn: () => fetchMember(id),
    enabled: !!id,
  })
}
