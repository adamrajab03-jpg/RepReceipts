import { useMemo, useState, useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useSearch } from '../hooks/useSearch'
import { useHearings } from '../hooks/useHearings'
import { useMembers } from '../hooks/useMembers'
import { useHearingTranscript } from '../hooks/useHearingTranscript'
import { snippetHtml } from '../utils/snippet'
import { memberLabel, chamberTitle, partyStateLabel, partyTextClass } from '../utils/memberDisplay'
import { tierBadge } from '../utils/hearingTier'
import { cn } from '../utils/cn'
import type { SearchResult } from '../types/api'

// Search is stricter than the transcript page: only hearings whose speakers have
// been reviewed. Mirror the backend's SEARCHABLE_STATUSES so the filter dropdowns
// only offer hearings/committees that can actually appear in results.
const SEARCHABLE = new Set(['published', 'attributed', 'verified'])
const PARTIES = [
  { value: 'D', label: 'Democrat' },
  { value: 'R', label: 'Republican' },
  { value: 'I', label: 'Independent' },
]

function fmtDate(iso: string | null) {
  if (!iso) return null
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function SearchPage() {
  const [params, setParams] = useSearchParams()
  const q = params.get('q') ?? ''
  const speaker = params.get('speaker') ?? ''
  const committee = params.get('committee') ?? ''
  const party = params.get('party') ?? ''
  const dateFrom = params.get('date_from') ?? ''
  const dateTo = params.get('date_to') ?? ''
  const hearing = params.get('hearing') ?? ''
  const sort = params.get('sort') ?? 'relevance'
  const page = Math.max(1, parseInt(params.get('page') ?? '1', 10) || 1)

  // The text box is a draft until submitted, so we don't fire a request per
  // keystroke; filters below apply immediately.
  const [draft, setDraft] = useState(q)
  useEffect(() => { setDraft(q) }, [q])

  const hasFilter = !!(speaker || committee || party || dateFrom || dateTo || hearing)
  const enabled = !!q || hasFilter

  // The current search as a URL, carried into member links so their "← Back"
  // returns here with the query and filters intact.
  const backTo = `/search?${params.toString()}`

  const { data, isLoading, isError, error, isFetching } = useSearch(
    { q, speaker, committee, party, date_from: dateFrom, date_to: dateTo, hearing, sort, page },
    enabled,
  )

  // Filter option sources. Hearings power BOTH the hearing dropdown and the
  // derived committee list; members + the selected hearing's witnesses power the
  // one speaker control.
  const hearingsQ = useHearings({})
  const membersQ = useMembers({})
  const transcriptQ = useHearingTranscript(hearing) // disabled unless a hearing is picked

  const searchableHearings = useMemo(
    () => (hearingsQ.data?.data ?? []).filter((h) => SEARCHABLE.has(h.status)),
    [hearingsQ.data],
  )
  const committees = useMemo(() => {
    const map = new Map<string, string>()
    for (const h of searchableHearings) {
      if (h.committee_id && h.committee_name) map.set(h.committee_id, h.committee_name)
    }
    return [...map.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
  }, [searchableHearings])

  const members = membersQ.data?.data ?? []
  const witnesses = (transcriptQ.data?.data.context.witnesses ?? []).filter((w) => w.witness_id)

  // Update one URL param; any change but paging resets to page 1.
  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(key, value); else next.delete(key)
    if (key !== 'page') next.delete('page')
    setParams(next, { replace: true })
  }

  function submitQuery(e: React.FormEvent) {
    e.preventDefault()
    setParam('q', draft.trim())
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1

  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-900 mb-1">Find a receipt</h1>
      <p className="text-sm text-gray-500 mb-6">Search all archived hearings.</p>

      {/* Query box */}
      <form onSubmit={submitQuery} className="flex gap-2 mb-4">
        <input
          type="search"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. Section 230"
          className="flex-1 border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-slate-400"
        />
        <button
          type="submit"
          className="px-5 py-2.5 rounded-lg bg-slate-800 text-white text-sm font-medium hover:bg-slate-700 transition-colors"
        >
          Search
        </button>
      </form>

      {/* Filters */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
        <Field label="Speaker">
          <select value={speaker} onChange={(e) => setParam('speaker', e.target.value)} className={selectCls}>
            <option value="">Anyone</option>
            <optgroup label="Members">
              {members.map((m) => (
                <option key={m.id} value={`m:${m.id}`}>
                  {memberLabel(m.full_name, m.chamber)}{m.party ? ` (${partyStateLabel(m.party, m.state)})` : ''}
                </option>
              ))}
            </optgroup>
            {hearing && witnesses.length > 0 && (
              <optgroup label="Witnesses (this hearing)">
                {witnesses.map((w) => (
                  <option key={w.witness_id!} value={`w:${w.witness_id}`}>{w.name}</option>
                ))}
              </optgroup>
            )}
          </select>
          {!hearing && (
            <span className="text-[11px] text-gray-400">Pick a hearing to filter by a witness.</span>
          )}
        </Field>

        <Field label="Committee">
          <select value={committee} onChange={(e) => setParam('committee', e.target.value)} className={selectCls}>
            <option value="">Any committee</option>
            {committees.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>

        <Field label="Party">
          <select value={party} onChange={(e) => setParam('party', e.target.value)} className={selectCls}>
            <option value="">Any party</option>
            {PARTIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </Field>

        <Field label="Hearing">
          <select value={hearing} onChange={(e) => setParam('hearing', e.target.value)} className={selectCls}>
            <option value="">Any hearing</option>
            {searchableHearings.map((h) => <option key={h.id} value={h.id}>{h.title}</option>)}
          </select>
        </Field>

        <Field label="From date">
          <input type="date" value={dateFrom} onChange={(e) => setParam('date_from', e.target.value)} className={selectCls} />
        </Field>

        <Field label="To date">
          <input type="date" value={dateTo} onChange={(e) => setParam('date_to', e.target.value)} className={selectCls} />
        </Field>
      </div>

      {/* Count + sort */}
      <div className="flex items-center justify-between mb-4 min-h-[2rem]">
        <p className="text-xs text-gray-500">
          {!enabled
            ? 'Enter a search term or choose a filter.'
            : data
              ? `${data.total} match${data.total !== 1 ? 'es' : ''} across ${data.hearings} hearing${data.hearings !== 1 ? 's' : ''}`
              : isLoading ? 'Searching…' : ''}
          {isFetching && data && <span className="ml-2 text-gray-300">updating…</span>}
        </p>
        {enabled && (
          <div className="flex rounded-lg border border-gray-300 overflow-hidden text-xs">
            {[['relevance', 'Relevance'], ['date', 'Newest']].map(([value, label]) => (
              <button
                key={value}
                onClick={() => setParam('sort', value)}
                disabled={value === 'relevance' && !q}
                title={value === 'relevance' && !q ? 'Relevance needs a search term' : undefined}
                className={cn(
                  'px-3 py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                  sort === value ? 'bg-slate-800 text-white' : 'bg-white text-gray-700 hover:bg-gray-50',
                )}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {isError && <p className="text-sm text-red-500">{(error as Error).message}</p>}

      {enabled && data && data.data.length === 0 && !isLoading && (
        <p className="text-sm text-gray-500 py-8 text-center">No turns match your search.</p>
      )}

      <div className="space-y-3">
        {data?.data.map((r) => (
          <div key={r.turn_id} className="flex min-h-[7rem] overflow-hidden rounded-lg border border-gray-200 bg-white hover:border-slate-300 transition-colors">
            {/* Full-height square: the speaker's identity */}
            <SpeakerSquare r={r} backTo={backTo} />

            {/* Right column: the hearing header, then the matching text */}
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b border-gray-100 bg-slate-50/60 px-4 py-2">
                <Link to={`/hearings/${r.hearing.id}`} className="text-sm font-semibold text-slate-900 hover:underline">
                  {r.hearing.title}
                </Link>
                {r.hearing.held_on && <span className="text-xs text-gray-400">{fmtDate(r.hearing.held_on)}</span>}
                <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded-full', tierBadge(r.hearing.status).cls)}>
                  {tierBadge(r.hearing.status).label}
                </span>
                <Link to={r.jump_url} className="ml-auto text-xs text-slate-600 font-medium hover:text-slate-900">
                  Jump to transcript →
                </Link>
              </div>
              <p
                className="flex-1 px-4 py-3 text-sm text-gray-800 leading-relaxed [&_mark]:bg-amber-200 [&_mark]:text-gray-900 [&_mark]:rounded-sm [&_mark]:px-0.5"
                dangerouslySetInnerHTML={{ __html: snippetHtml(r.snippet) }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      {data && data.total > data.page_size && (
        <div className="flex items-center justify-center gap-4 mt-6 text-sm">
          <button
            onClick={() => setParam('page', String(page - 1))}
            disabled={page <= 1}
            className="px-3 py-1.5 rounded-lg border border-gray-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
          >
            ← Prev
          </button>
          <span className="text-gray-500">Page {page} of {totalPages}</span>
          <button
            onClick={() => setParam('page', String(page + 1))}
            disabled={page >= totalPages}
            className="px-3 py-1.5 rounded-lg border border-gray-300 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The full-height square on the left of a result, holding the speaker's identity:
 * a ROLE label ("Sen."/"Rep." for members, "Witness" for witnesses), the name,
 * and an affiliation. A member links to their profile — and carries the current
 * search in nav state, so the profile's "← Back" returns to these results; a
 * witness renders as plain text (witness pages don't exist yet).
 */
function SpeakerSquare({ r, backTo }: { r: SearchResult; backTo: string }) {
  const isMember = !!r.speaker.member_id
  const role = isMember ? (chamberTitle(r.speaker.chamber) ?? 'Member') : 'Witness'
  const name = isMember ? (r.speaker.full_name ?? 'Unknown') : (r.speaker_name ?? 'Unknown speaker')
  const affiliation = isMember
    ? partyStateLabel(r.speaker.party, r.speaker.state)
    : (r.witness?.industry_label ?? r.witness?.organization ?? null)

  const body = (
    <>
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">{role}</span>
      <span className="mt-1 text-sm font-semibold leading-snug text-slate-900 break-words">{name}</span>
      {affiliation && (
        <span className={cn('mt-0.5 text-xs', isMember ? partyTextClass(r.speaker.party) : 'text-slate-500')}>
          {affiliation}
        </span>
      )}
    </>
  )

  // self-stretch takes the row's full height; aspect-square then derives an equal
  // width from it, so the box is a square as tall as the whole result card.
  const cls = 'flex aspect-square shrink-0 flex-col items-center justify-center self-stretch border-r border-gray-100 bg-slate-50 p-3 text-center'
  return isMember ? (
    <Link
      to={`/members/${r.speaker.member_id}`}
      state={{ from: 'search', backTo }}
      className={cn(cls, 'transition-colors hover:bg-slate-100')}
    >
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  )
}

const selectCls = 'w-full text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white'

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400">{label}</span>
      {children}
    </label>
  )
}
