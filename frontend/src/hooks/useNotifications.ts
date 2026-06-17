import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../utils/apiFetch'
import { useAuthStore } from '../store/authStore'
import type { AppNotification } from '../types/api'

const LIST_KEY  = ['notifications']
const COUNT_KEY = ['notifications', 'unread-count']

// ── Feed ──────────────────────────────────────────────────────────────────────
export function useNotifications(enabled = true) {
  const user = useAuthStore(s => s.user)
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: async () => {
      const res = await fetch('/api/notifications')
      if (!res.ok) throw new Error('Failed to fetch notifications')
      const { data } = (await res.json()) as { data: AppNotification[] }
      return data
    },
    enabled: !!user && enabled,
    staleTime: 15_000,
  })
}

// ── Unread count (badge) — polls so the badge stays fresh ─────────────────────
export function useUnreadCount() {
  const user = useAuthStore(s => s.user)
  return useQuery({
    queryKey: COUNT_KEY,
    queryFn: async () => {
      const res = await fetch('/api/notifications/unread-count')
      if (!res.ok) throw new Error('Failed to fetch unread count')
      const { count } = (await res.json()) as { count: number }
      return count
    },
    enabled: !!user,
    refetchInterval: 30_000,
    staleTime: 15_000,
  })
}

export function useMarkRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await apiFetch(`/api/notifications/${id}/read`, { method: 'POST' })
      if (!res.ok) throw new Error('Failed to mark read')
      return id
    },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: LIST_KEY })
      const list  = qc.getQueryData<AppNotification[]>(LIST_KEY)
      const count = qc.getQueryData<number>(COUNT_KEY)
      const wasUnread = list?.find(n => n.id === id)?.read_at == null
      qc.setQueryData<AppNotification[]>(LIST_KEY, old =>
        old?.map(n => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n))
      )
      if (wasUnread && typeof count === 'number') {
        qc.setQueryData<number>(COUNT_KEY, Math.max(0, count - 1))
      }
      return { list, count }
    },
    onError: (_e, _id, ctx) => {
      if (ctx?.list  !== undefined) qc.setQueryData(LIST_KEY, ctx.list)
      if (ctx?.count !== undefined) qc.setQueryData(COUNT_KEY, ctx.count)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY })
      qc.invalidateQueries({ queryKey: COUNT_KEY })
    },
  })
}

export function useMarkAllRead() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const res = await apiFetch('/api/notifications/read-all', { method: 'POST' })
      if (!res.ok) throw new Error('Failed to mark all read')
    },
    onMutate: async () => {
      await qc.cancelQueries({ queryKey: LIST_KEY })
      const list  = qc.getQueryData<AppNotification[]>(LIST_KEY)
      const count = qc.getQueryData<number>(COUNT_KEY)
      const now = new Date().toISOString()
      qc.setQueryData<AppNotification[]>(LIST_KEY, old =>
        old?.map(n => (n.read_at ? n : { ...n, read_at: now }))
      )
      qc.setQueryData<number>(COUNT_KEY, 0)
      return { list, count }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.list  !== undefined) qc.setQueryData(LIST_KEY, ctx.list)
      if (ctx?.count !== undefined) qc.setQueryData(COUNT_KEY, ctx.count)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: LIST_KEY })
      qc.invalidateQueries({ queryKey: COUNT_KEY })
    },
  })
}
