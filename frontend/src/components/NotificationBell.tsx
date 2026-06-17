import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  useNotifications, useUnreadCount, useMarkRead, useMarkAllRead,
} from '../hooks/useNotifications'
import type { AppNotification, NotificationKind } from '../types/api'
import { cn } from '../utils/cn'

// Icon per notification kind. rep/topic/rep+topic = system activity; reply &
// mention = social. Falls back to a generic dot for any unknown future kind.
const KIND_ICON: Record<NotificationKind, string> = {
  rep_activity:       '🏛️',
  topic_activity:     '🏷️',
  rep_topic_activity: '🎯',
  reply:              '↩️',
  mention:            '@',
}

function timeAgo(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false)
  const { data: count = 0 } = useUnreadCount()
  const { data: items, isLoading } = useNotifications(open)   // only fetch the feed when open
  const markRead    = useMarkRead()
  const markAllRead = useMarkAllRead()

  const onItemClick = (n: AppNotification) => {
    if (!n.read_at) markRead.mutate(n.id)
    setOpen(false)
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className="relative text-slate-300 hover:text-white transition-colors"
        aria-label="Notifications"
      >
        <span className="text-xl leading-none">🔔</span>
        {count > 0 && (
          <span className="absolute -top-1.5 -right-1.5 bg-red-500 text-white text-[10px] font-bold leading-none min-w-[1rem] h-4 px-1 rounded-full flex items-center justify-center">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* click-away backdrop */}
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto bg-white text-gray-800 rounded-lg shadow-xl border border-gray-200 z-40">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 sticky top-0 bg-white">
              <span className="text-sm font-semibold">Notifications</span>
              {count > 0 && (
                <button
                  onClick={() => markAllRead.mutate()}
                  disabled={markAllRead.isPending}
                  className="text-xs text-teal-600 hover:text-teal-800 disabled:opacity-50"
                >
                  Mark all read
                </button>
              )}
            </div>

            {isLoading && <p className="px-4 py-6 text-sm text-gray-400">Loading…</p>}
            {items && items.length === 0 && (
              <p className="px-4 py-6 text-sm text-gray-400 text-center">No notifications yet.</p>
            )}
            {items?.map(n => (
              <Link
                key={n.id}
                to={n.payload.link}
                onClick={() => onItemClick(n)}
                className={cn(
                  'block px-4 py-3 border-b border-gray-50 hover:bg-gray-50 transition-colors',
                  n.read_at ? 'bg-white' : 'bg-teal-50/40'
                )}
              >
                <div className="flex items-start gap-2">
                  {!n.read_at && <span className="mt-1.5 w-2 h-2 rounded-full bg-teal-500 shrink-0" />}
                  <span className={cn('text-sm leading-5 shrink-0', n.read_at && 'pl-4')}>
                    {KIND_ICON[n.payload.kind] ?? '•'}
                  </span>
                  <div>
                    <p className="text-sm text-gray-800">{n.payload.text}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{timeAgo(n.created_at)}</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
