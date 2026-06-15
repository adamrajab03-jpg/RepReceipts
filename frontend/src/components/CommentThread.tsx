import { useState } from 'react'
import { type WordTime } from '../types/api'
import { useComments, buildTree, type CommentScope } from '../hooks/useComments'
import { useAuthStore } from '../store/authStore'
import CommentItem from './CommentItem'
import CommentForm from './CommentForm'

interface TurnRef {
  id:         string
  seq:        number
  raw_text:   string
  clean_text: string | null
  word_times: WordTime[] | null
}

interface CommentThreadProps {
  scope:            CommentScope
  turnRef?:         TurnRef
  defaultCollapsed?: boolean
}

export default function CommentThread({ scope, turnRef, defaultCollapsed = false }: CommentThreadProps) {
  const [collapsed,   setCollapsed]   = useState(defaultCollapsed)
  const [showForm,    setShowForm]    = useState(false)
  const user = useAuthStore(s => s.user)

  const { data, isLoading, isError } = useComments(scope, !collapsed)
  const roots = data ? buildTree(data) : []
  const count = data?.length ?? 0

  return (
    <div className="border-t border-gray-100 pt-2 mt-3">
      {/* Toggle header */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => setCollapsed(v => !v)}
          className="text-xs text-gray-500 hover:text-gray-700 transition-colors"
        >
          {collapsed
            ? `▸ Comments${count ? ` (${count})` : ''}`
            : `▾ Hide comments`}
        </button>

        {!collapsed && user && !showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="text-xs text-slate-600 hover:text-slate-800 transition-colors"
          >
            + Add comment
          </button>
        )}
      </div>

      {!collapsed && (
        <div className="mt-2 space-y-1">
          {/* Top-level comment form */}
          {showForm && (
            <div className="mb-3">
              <CommentForm
                scope={scope}
                onDone={() => setShowForm(false)}
                autoFocus
              />
            </div>
          )}

          {isLoading && <p className="text-xs text-gray-400">Loading…</p>}
          {isError   && <p className="text-xs text-red-500">Failed to load comments.</p>}

          {!isLoading && !isError && roots.length === 0 && (
            <p className="text-xs text-gray-400">
              {user ? 'No comments yet — be the first.' : 'No comments yet.'}
            </p>
          )}

          {roots.map(node => (
            <CommentItem
              key={node.id}
              comment={node}
              scope={scope}
              depth={0}
              turnRef={turnRef}
            />
          ))}
        </div>
      )}
    </div>
  )
}
