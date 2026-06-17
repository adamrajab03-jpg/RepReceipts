import { useQuery } from '@tanstack/react-query'
import type { ListResponse, TopicTree, MemberTopic } from '../types/api'

export function useTopics() {
  return useQuery({
    queryKey: ['topics'],
    queryFn: async () => {
      const res = await fetch('/api/topics')
      if (!res.ok) throw new Error('Failed to fetch topics')
      return res.json() as Promise<ListResponse<TopicTree>>
    },
    staleTime: 5 * 60_000,
  })
}

export function useMemberTopics(memberId: string) {
  return useQuery({
    queryKey: ['member-topics', memberId],
    queryFn: async () => {
      const res = await fetch(`/api/members/${memberId}/topics`)
      if (!res.ok) throw new Error('Failed to fetch member topics')
      return res.json() as Promise<ListResponse<MemberTopic>>
    },
    enabled: !!memberId,
  })
}
