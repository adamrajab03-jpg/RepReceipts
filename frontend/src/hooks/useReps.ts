import { useQuery } from '@tanstack/react-query'
import type { DetailResponse, RepsLookup } from '../types/api'

async function fetchReps(zip: string): Promise<RepsLookup> {
  const res = await fetch(`/api/lookup/reps?zip=${encodeURIComponent(zip)}`)
  const body = await res.json().catch(() => ({}))
  // Surface the backend's friendly 400/404 message as the thrown error.
  if (!res.ok) throw new Error((body as { error?: string }).error ?? 'Lookup failed')
  return (body as DetailResponse<RepsLookup>).data
}

// Only fires for a well-formed 5-digit ZIP; format errors are handled in the page.
export function useReps(zip: string | null) {
  return useQuery({
    queryKey: ['reps', zip],
    queryFn: () => fetchReps(zip as string),
    enabled: !!zip && /^\d{5}$/.test(zip),
    retry: false,
  })
}
