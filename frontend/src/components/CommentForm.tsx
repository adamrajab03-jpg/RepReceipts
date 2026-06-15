import { useState } from 'react'
import { useCreateComment, type CommentScope } from '../hooks/useComments'
import { useAuthStore } from '../store/authStore'
import { Link } from 'react-router-dom'

interface CommentFormProps {
  scope:      CommentScope
  parentId?:  string
  quote?:     { char_start: number; char_end: number; quoted_text: string }
  onDone:     () => void
  autoFocus?: boolean
  placeholder?: string
}

export default function CommentForm({
  scope, parentId, quote, onDone, autoFocus, placeholder,
}: CommentFormProps) {
  const user       = useAuthStore(s => s.user)
  const create     = useCreateComment()
  const [body, setBody]   = useState('')
  const [error, setError] = useState('')

  if (!user) {
    return (
      <p className="text-xs text-gray-500">
        <Link to="/login" className="text-slate-700 hover:underline font-medium">Sign in</Link>
        {' '}to comment.
      </p>
    )
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!body.trim()) { setError('Comment cannot be empty'); return }
    setError('')
    create.mutate(
      { scope, body: body.trim(), parent_id: parentId, quote },
      { onSuccess: () => { setBody(''); onDone() },
        onError: err => setError(err.message) }
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-2">
      {quote && (
        <blockquote className="border-l-4 border-amber-400 pl-3 text-xs text-gray-500 italic line-clamp-3">
          "{quote.quoted_text}"
        </blockquote>
      )}

      <textarea
        value={body}
        onChange={e => setBody(e.target.value)}
        placeholder={placeholder ?? 'Write a comment…'}
        rows={3}
        autoFocus={autoFocus}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-slate-400"
      />

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={create.isPending}
          className="text-xs bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white px-3 py-1.5 rounded-lg transition-colors"
        >
          {create.isPending ? 'Posting…' : quote ? 'Post with quote' : 'Post comment'}
        </button>
        <button
          type="button"
          onClick={() => { setBody(''); onDone() }}
          className="text-xs text-gray-500 hover:text-gray-700 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
