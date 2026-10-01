// Render a search snippet's highlight safely.
//
// The backend's ts_headline wraps matched terms in two private-use sentinel
// chars (U+E000 / U+E001) rather than literal <mark>, because ts_headline does
// NOT HTML-escape the document — a transcript containing '<' or '>' would emit
// raw tags. So we escape the ENTIRE snippet to text first, THEN swap the
// sentinels for <mark></mark>. The only tags that can reach the DOM are the ones
// we introduce here. Kept in sync with backend searchController (MARK_START/STOP).

const MARK_START = '\uE000'
const MARK_STOP = '\uE001'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Escaped snippet HTML whose only tags are <mark> around matched terms. */
export function snippetHtml(snippet: string): string {
  return escapeHtml(snippet)
    .split(MARK_START).join('<mark>')
    .split(MARK_STOP).join('</mark>')
}
