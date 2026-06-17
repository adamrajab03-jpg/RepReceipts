import { useState } from 'react'
import { type CommentNode, type WordTime } from '../types/api'
import { type CommentScope, useVoteComment, useDeleteComment } from '../hooks/useComments'
import { useAuthStore } from '../store/authStore'
import { resolveToMs, msToTimestamp } from '../utils/resolveMs'
import CommentForm from './CommentForm'
import { renderCommentBody } from '../utils/mentions'

const MAX_INDENT = 4

interface TurnRef {
  id:         string
  seq:        number
  raw_text:   string
  clean_text: string | null
  word_times: WordTime[] | null
}

interface CommentItemProps {
  comment: CommentNode
  scope:   CommentScope
  depth:   number
  turnRef?: TurnRef
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1)   return 'just now'
  if (m < 60)  return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24)  return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default function CommentItem({ comment: c, scope, depth, turnRef }: CommentItemProps) {
  const user     = useAuthStore(s => s.user)
  const vote     = useVoteComment()
  const del      = useDeleteComment()
  const [replying, setReplying] = useState(false)

  const canDelete = !!user && !c.is_deleted && (user.id === c.user_id || user.is_admin)

  const handleDelete = () => {
    if (!window.confirm('Delete this comment?')) return
    del.mutate({ commentId: c.id, scope })
  }

  // Resolve quote char_start → video timestamp
  const quoteMs =
    c.char_start != null && turnRef?.word_times?.length
      ? resolveToMs(turnRef.word_times, turnRef.clean_text ?? turnRef.raw_text, c.char_start)
      : null

  const castVote = (val: 1 | -1) => {
    if (!user) return
    vote.mutate({ commentId: c.id, value: val, scope })
  }

  const indent = Math.min(depth, MAX_INDENT)

  return (
    <div style={{ marginLeft: indent > 0 ? `${indent * 1.25}rem` : 0 }}>
      <div className="py-2">
        {/* Quote blockquote */}
        {!c.is_deleted && c.quoted_text && (
          <blockquote className="mb-1.5 border-l-4 border-amber-400 pl-3 text-xs text-gray-500 italic">
            <span>"{c.quoted_text}"</span>
            {quoteMs != null && (
              <a
                href={`#turn-${turnRef!.seq}`}
                className="ml-2 text-amber-600 hover:underline not-italic font-mono"
              >
                → {msToTimestamp(quoteMs)}
              </a>
            )}
          </blockquote>
        )}

        {/* Body */}
        <p className={`text-sm ${c.is_deleted ? 'text-gray-400 italic' : 'text-gray-800'}`}>
          {c.is_deleted ? c.body : renderCommentBody(c.body)}
        </p>

        {/* Meta row */}
        <div className="flex items-center gap-3 mt-1">
          {/* Vote */}
          {!c.is_deleted && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => castVote(1)}
                disabled={!user || vote.isPending}
                title="Upvote"
                className={`text-xs px-1 rounded transition-colors disabled:opacity-40 ${
                  c.user_vote === 1
                    ? 'text-emerald-600 font-bold'
                    : 'text-gray-400 hover:text-emerald-600'
                }`}
              >
                ▲
              </button>
              <span className={`text-xs tabular-nums min-w-[1.5ch] text-center ${
                c.score > 0 ? 'text-emerald-600' : c.score < 0 ? 'text-red-500' : 'text-gray-400'
              }`}>
                {c.score}
              </span>
              <button
                onClick={() => castVote(-1)}
                disabled={!user || vote.isPending}
                title="Downvote"
                className={`text-xs px-1 rounded transition-colors disabled:opacity-40 ${
                  c.user_vote === -1
                    ? 'text-red-500 font-bold'
                    : 'text-gray-400 hover:text-red-500'
                }`}
              >
                ▼
              </button>
            </div>
          )}

          {!c.is_deleted && c.author_handle && (
            <span className="text-xs text-gray-500 font-medium">@{c.author_handle}</span>
          )}
          <span className="text-xs text-gray-400">{timeAgo(c.created_at)}</span>

          {user && !c.is_deleted && (
            <button
              onClick={() => setReplying(v => !v)}
              className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
            >
              {replying ? 'Cancel' : 'Reply'}
            </button>
          )}

          {canDelete && (
            <button
              onClick={handleDelete}
              disabled={del.isPending}
              className="text-xs text-gray-400 hover:text-red-500 transition-colors disabled:opacity-40"
            >
              Delete
            </button>
          )}
        </div>

        {replying && (
          <div className="mt-2">
            <CommentForm
              scope={scope}
              parentId={c.id}
              onDone={() => setReplying(false)}
              autoFocus
              placeholder={`Replying to @${c.author_handle ?? 'someone'}…`}
            />
          </div>
        )}
      </div>

      {/* Recursive children */}
      {c.children.map(child => (
        <CommentItem
          key={child.id}
          comment={child}
          scope={scope}
          depth={depth + 1}
          turnRef={turnRef}
        />
      ))}
    </div>
  )
}
