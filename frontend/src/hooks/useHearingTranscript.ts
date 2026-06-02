import { useQuery } from '@tanstack/react-query'
import type { DetailResponse, HearingTranscript } from '../types/api'

async function fetchHearingTranscript(id: string): Promise<DetailResponse<HearingTranscript>> {
  const res = await fetch(`/api/hearings/${id}/transcript`)
  if (!res.ok) throw new Error('Failed to fetch transcript')
  return res.json()
}

export function useHearingTranscript(id: string) {
  return useQuery({
    queryKey: ['hearing-transcript', id],
    queryFn: () => fetchHearingTranscript(id),
    enabled: !!id,
  })
}
