import { Fragment, type ReactNode } from 'react'

// Mirrors the backend matcher (notificationsController.parseMentions): @handle
// where handle is [A-Za-z0-9_]{3,30}, bounded by non-handle chars so "email@bob"
// doesn't match. Rendered as a styled span (not a link) — a real /u/:handle
// profile route is a fast-follow.
const MENTION_RE = /(?<![A-Za-z0-9_])@([A-Za-z0-9_]{3,30})(?![A-Za-z0-9_])/g

export function renderCommentBody(body: string): ReactNode {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  for (const m of body.matchAll(MENTION_RE)) {
    const start = m.index ?? 0
    if (start > last) out.push(<Fragment key={i++}>{body.slice(last, start)}</Fragment>)
    out.push(
      <span key={i++} className="text-violet-600 font-medium">
        @{m[1]}
      </span>
    )
    last = start + m[0].length
  }
  if (last < body.length) out.push(<Fragment key={i++}>{body.slice(last)}</Fragment>)
  return out
}
