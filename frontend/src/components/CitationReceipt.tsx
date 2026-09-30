import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Citation, CitationSpeaker, CitationView } from '../types/api'
import { useHearingVideo } from './HearingVideo'
import { memberLabel, partyPillClass, partyStateLabel } from '../utils/memberDisplay'
import { formatTimecode } from '../utils/timecode'
import { tierBadge } from '../utils/hearingTier'
import { youtubeWatchAt } from '../utils/youtube'
import { copyText } from '../utils/clipboard'
import { wordDiff } from '../utils/wordDiff'
import { cn } from '../utils/cn'
import { receiptOriginLabel } from '../utils/textOrigin'

// ============================================================================
//  The landing experience for a shared quote (/q/:code): "X said this".
//
//  Honesty rules, in the order a reader meets them:
//    - The passage highlighted is ALWAYS the current text — readers see the
//      transcript as it now stands, never a stale copy dressed up as live.
//    - If it differs from what was shared, say so, and keep the original one
//      click away with exactly what changed. Never silently swap words.
//    - If the words now sit under a different speaker, say THAT prominently:
//      it changes the claim itself, not just its wording.
//    - If the passage can't be found, show the original snapshot as the
//      snapshot, labelled as such — never a broken link, never a guess.
// ============================================================================

/** Playback starts this far before the quote, so the first word isn't clipped. */
export const QUOTE_LEAD_IN_MS = 1000

const sharedOn = (c: Citation) =>
  new Date(c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

/** The speaker as recorded on the receipt when it was shared. */
function snapshotSpeaker(c: Citation): CitationSpeaker {
  return {
    member_id: c.member_id, name: c.speaker_name, role: c.speaker_role,
    party: c.speaker_party, state: c.speaker_state, chamber: c.speaker_chamber,
  }
}

const speakerLabel = (s: CitationSpeaker) => (s.member_id ? memberLabel(s.name, s.chamber) : s.name)

function SpeakerName({ speaker, size = 'lg' }: { speaker: CitationSpeaker; size?: 'lg' | 'sm' }) {
  const pill = partyPillClass(speaker.party)
  const ps = partyStateLabel(speaker.party, speaker.state)
  const label = speakerLabel(speaker)
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      {speaker.member_id ? (
        <Link
          to={`/members/${speaker.member_id}`}
          className={cn(
            'font-semibold tracking-tight text-slate-900 underline decoration-slate-300 underline-offset-[3px] hover:decoration-slate-900',
            size === 'lg' ? 'text-base' : 'text-sm',
          )}
        >
          {label}
        </Link>
      ) : (
        <span className={cn('font-semibold text-slate-900', size === 'lg' ? 'text-base' : 'text-sm')}>{label}</span>
      )}
      {pill && ps && (
        <span className={cn('rounded px-1 text-[10px] font-bold leading-4 ring-1 ring-inset', pill)}>{ps}</span>
      )}
    </span>
  )
}

/** "▶ Watch this moment" — seeks the docked player; a YouTube link without one. */
function WatchMoment({ seekMs, videoUrl }: { seekMs: number | null; videoUrl: string | null }) {
  const { canSeek, seek } = useHearingVideo()
  if (seekMs == null) return null
  const from = Math.max(0, seekMs - QUOTE_LEAD_IN_MS)
  const cls = 'inline-flex items-baseline gap-1 rounded-md bg-slate-900 px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-slate-700'
  if (canSeek) {
    return (
      <button onClick={() => seek(from)} className={cls}>
        <span aria-hidden className="text-[9px]">▶</span> Watch this moment
      </button>
    )
  }
  const href = youtubeWatchAt(videoUrl, from)
  if (!href) return null
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cls}>
      <span aria-hidden className="text-[9px]">▶</span> Watch this moment <span className="sr-only">(opens YouTube)</span>
    </a>
  )
}

function CopyLink() {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const t = setTimeout(() => setState('idle'), 2000)
    return () => clearTimeout(t)
  }, [state])
  return (
    <button
      onClick={async () => setState((await copyText(window.location.href)) ? 'copied' : 'failed')}
      className="inline-flex items-baseline gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:border-slate-400 hover:text-slate-900"
    >
      {state === 'copied' ? '✓ Link copied' : state === 'failed' ? 'Copy failed — use the address bar' : <><span aria-hidden>🔗</span> Copy link</>}
    </button>
  )
}

/** The receipt's header line: what this is, when it was shared, and the trust
 *  tier it carried then if that wasn't human-verified. */
function ReceiptHeader({ c }: { c: Citation }) {
  const tier = c.hearing_status !== 'verified' ? tierBadge(c.hearing_status) : null
  const origin = receiptOriginLabel(c.text_origin)
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
      <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-amber-800">Shared quote</span>
      <span className="text-xs text-slate-500">shared {sharedOn(c)}</span>
      {tier && (
        <span className={cn('rounded px-1.5 py-px text-[10px] font-medium', tier.cls)} title="The hearing's trust level when this quote was shared">
          {tier.label} when shared
        </span>
      )}
      {origin && (
        <span className="rounded border border-slate-300 bg-white px-1.5 py-px text-[10px] font-medium text-slate-700" title={origin.title}>
          ✎ {origin.label}
        </span>
      )}
    </div>
  )
}

/** The original snapshot, plus exactly what changed since. */
function OriginalPanel({ c, current }: { c: Citation; current: string | null }) {
  const ops = current != null ? wordDiff(c.quoted_text, current) : null
  return (
    <div className="mt-2 space-y-2 rounded-md border border-slate-200 bg-white px-3 py-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500">As shared on {sharedOn(c)}</p>
      <blockquote className="font-serif text-[15px] leading-relaxed text-slate-800">“{c.quoted_text}”</blockquote>
      {ops && (
        <>
          <p className="pt-1 text-[11px] font-semibold uppercase tracking-[0.1em] text-slate-500">
            What changed <span className="font-normal normal-case tracking-normal">— <del className="text-red-700">removed</del>, <ins className="text-green-800">added</ins></span>
          </p>
          <p className="font-serif text-[15px] leading-relaxed text-slate-800">
            {ops.map((op, i) => (
              <span key={i}>
                {i > 0 && ' '}
                {op.type === 'same' ? op.text
                  : op.type === 'del' ? <del className="bg-red-50 text-red-700 decoration-red-400">{op.text}</del>
                  : <ins className="bg-green-50 text-green-800 decoration-green-500 underline-offset-2">{op.text}</ins>}
              </span>
            ))}
          </p>
        </>
      )}
    </div>
  )
}

function Notice({ tone = 'note', children }: { tone?: 'note' | 'alert'; children: React.ReactNode }) {
  return (
    <div className={cn(
      'mt-2 rounded-md px-3 py-2 text-[13px] leading-snug',
      tone === 'alert' ? 'border border-red-200 bg-red-50 text-red-900' : 'border border-amber-200 bg-white/70 text-slate-800',
    )}>
      {children}
    </div>
  )
}

/**
 * The bar inside the quoted turn, above the highlighted passage (match or
 * diverged). The speaker shown is the CURRENT attribution — the best record we
 * have — with any change from the receipt called out beneath.
 */
export function CitationReceiptBar({ view, videoUrl }: { view: CitationView; videoUrl: string | null }) {
  const { citation: c, resolution: r } = view
  const [showOriginal, setShowOriginal] = useState(false)
  const speakers = r.current_speakers.filter((s, i, all) => all.findIndex((x) => speakerLabel(x) === speakerLabel(s)) === i)
  const diverged = r.status === 'diverged'

  return (
    <aside aria-label="Shared quote" className="mb-3 rounded-lg border border-amber-200 bg-amber-50/60 px-4 py-3 font-sans">
      <ReceiptHeader c={c} />

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          {speakers.map((s, i) => (
            <span key={i} className="inline-flex items-baseline gap-x-1.5">
              {i > 0 && <span className="text-slate-400">&amp;</span>}
              <SpeakerName speaker={s} />
            </span>
          ))}
          <span className="text-sm text-slate-600">
            said this{c.seek_ms != null && <> at <time className="tabular-nums">{formatTimecode(c.seek_ms)}</time></>}
          </span>
        </span>
        <span className="flex flex-wrap gap-2 sm:ml-auto">
          <WatchMoment seekMs={c.seek_ms} videoUrl={videoUrl} />
          <CopyLink />
        </span>
      </div>

      {r.attribution_changed && (
        <Notice tone="alert">
          <strong className="font-semibold">Attribution changed.</strong>{' '}
          When this quote was shared it was attributed to <SpeakerName speaker={snapshotSpeaker(c)} size="sm" />.{' '}
          {r.mixed_speakers
            ? <>The passage now spans turns by {speakers.map(speakerLabel).join(' and ')}.</>
            : <>It is now attributed to <SpeakerName speaker={speakers[0]} size="sm" />.</>}
        </Notice>
      )}
      {!r.attribution_changed && r.mixed_speakers && (
        <Notice>The passage now spans turns by {speakers.map(speakerLabel).join(' and ')}.</Notice>
      )}

      {diverged && (
        <Notice>
          {r.change === 'formatting'
            ? <>Punctuation or capitalization in this passage was corrected since this quote was shared on {sharedOn(c)}.</>
            : <>This passage has been edited since this quote was shared on {sharedOn(c)}. The highlighted text is the current transcript.</>}{' '}
          <button
            onClick={() => setShowOriginal((v) => !v)}
            aria-expanded={showOriginal}
            className="font-medium text-slate-900 underline decoration-slate-400 underline-offset-2 hover:decoration-slate-900"
          >
            {showOriginal ? 'Hide the original ▴' : 'View the original ▾'}
          </button>
          {showOriginal && <OriginalPanel c={c} current={r.current_text} />}
        </Notice>
      )}
    </aside>
  )
}

/**
 * The passage could not be located (or isn't in the transcript this page
 * rendered). Show the receipt itself — the snapshot, as the snapshot.
 */
export function CitationNotFound({ view, videoUrl }: { view: CitationView; videoUrl: string | null }) {
  const c = view.citation
  return (
    <section aria-label="Shared quote" className="mb-6 rounded-lg border border-amber-200 bg-amber-50/60 px-5 py-4">
      <ReceiptHeader c={c} />
      <blockquote className="mt-3 border-l-2 border-amber-300 pl-4 font-serif text-[17px] leading-[1.75] text-slate-800">
        “{c.quoted_text}”
      </blockquote>
      <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 pl-4">
        <span className="text-slate-400">—</span>
        <SpeakerName speaker={snapshotSpeaker(c)} />
        {c.seek_ms != null && <span className="text-sm tabular-nums text-slate-600">at {formatTimecode(c.seek_ms)}</span>}
      </div>
      <Notice>
        The original passage could not be located in the current transcript — it may have been substantially
        edited or removed. This is the text exactly as it was when shared on {sharedOn(c)}.
      </Notice>
      <div className="mt-3 flex flex-wrap gap-2">
        <WatchMoment seekMs={c.seek_ms} videoUrl={videoUrl} />
        <CopyLink />
      </div>
    </section>
  )
}

/** Parks the docked player at the quote's moment on landing — no autoplay. */
export function CitationVideoCue({ seekMs }: { seekMs: number | null }) {
  const { cue, videoId } = useHearingVideo()
  useEffect(() => {
    if (seekMs != null && videoId) cue(Math.max(0, seekMs - QUOTE_LEAD_IN_MS))
  }, [seekMs, videoId, cue])
  return null
}
