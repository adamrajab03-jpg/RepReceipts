import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useCitation } from '../hooks/useCitation'
import HearingTranscriptPage from './HearingTranscriptPage'
import { memberLabel } from '../utils/memberDisplay'

/**
 * /q/:code — a shared quote. Renders the hearing page itself (the URL stays the
 * short link, so it can be re-shared as-is), scrolled to and highlighting the
 * passage, with the receipt bar — or the receipt card when it can't be found.
 *
 * DEFERRED (follow-up slice): social link previews. X / Slack / iMessage read
 * <meta property="og:*"> from the raw HTML, which a client-rendered page can't
 * supply — the server has to answer /q/:code with the quote, speaker and
 * hearing in its meta tags. The document.title below only helps open tabs.
 */
export default function CitationPage() {
  const { code } = useParams<{ code: string }>()
  const { data, isLoading, isError, error } = useCitation(code!)
  const view = data?.data

  // The tab says who said what — this is the page people land on from a post.
  useEffect(() => {
    if (!view) return
    const c = view.citation
    const who = c.member_id ? memberLabel(c.speaker_name, c.speaker_chamber) : c.speaker_name
    const words = c.quoted_text.length > 80 ? `${c.quoted_text.slice(0, 77).trimEnd()}…` : c.quoted_text
    const prev = document.title
    document.title = `${who}: “${words}” · Rep Receipts`
    return () => { document.title = prev }
  }, [view])

  if (isLoading) return <p className="text-sm text-gray-500">Loading quote…</p>
  if (isError || !view) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm text-gray-700">
          {(error as Error | null)?.message === 'not_found'
            ? 'This quote link doesn’t exist. Check that it was copied in full.'
            : 'This quote couldn’t be loaded right now — please try again.'}
        </p>
        <Link to="/hearings" className="mt-3 inline-block text-sm text-gray-500 hover:text-gray-700">Browse hearings →</Link>
      </div>
    )
  }
  return <HearingTranscriptPage hearingId={view.citation.hearing_id} citation={view} />
}
