import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type MouseEvent, type ReactNode, type RefObject,
} from 'react'
import { youtubeVideoId, youtubeWatchAt } from '../utils/youtube'
import { loadYouTubeIframeApi, type YTPlayer } from '../utils/youtubeIframeApi'
import { useIsDesktop } from '../hooks/useMediaQuery'
import { cn } from '../utils/cn'

// ============================================================================
//  The docked hearing video — ONE embedded player per page that every "▶ Watch"
//  link seeks, instead of opening YouTube in a new tab.
// ----------------------------------------------------------------------------
//  The provider owns the player handle and the collapsed/expanded choice; the
//  frame (the actual iframe) is rendered in exactly one place — the sidebar on
//  desktop, a mini-player hanging off the sticky section bar on mobile — and
//  registers itself here once YouTube says it is ready.
//
//  A seek that arrives before the player is ready (collapsed-by-default on
//  mobile, API script still loading, frame remounting after a breakpoint flip)
//  is parked and fired from onReady — never silently dropped. The iframe is
//  only created the first time the player is shown, so a reader who never opens
//  it never pays for YouTube's embed.
// ============================================================================

interface HearingVideo {
  /** YouTube id, or null when the hearing has no usable video_url. */
  videoId: string | null
  /** True when Watch links should seek the docked player (vs. open a new tab). */
  canSeek: boolean
  expanded: boolean
  /** The iframe has been shown at least once, so it exists (possibly hidden). */
  activated: boolean
  failed: boolean
  setExpanded: (v: boolean) => void
  seek: (ms: number) => void
  /**
   * Park the player at a moment WITHOUT playing it — a shared quote's landing
   * page cues its moment, and the reader presses play (browsers block autoplay
   * with sound, and starting a video unasked would be pushy anyway). Applies
   * whenever the player next becomes ready; a seek() supersedes it.
   */
  cue: (ms: number) => void
  /** onClick for an <a href=youtube…>: plain clicks seek; modified clicks still open the tab. */
  seekClick: (ms: number) => ((e: MouseEvent) => void) | undefined
  /** Reader-chosen player widths in px (null = the layout's default), per placement. */
  sidebarWidth: number | null
  floatWidth: number | null
  setSidebarWidth: (w: number) => void
  setFloatWidth: (w: number) => void
  /** Widest the sidebar player can get before the transcript would hit the
   *  viewport edge — measured by useSidebarBreakout, which owns the layout. */
  sidebarMax: number
  setSidebarMax: (w: number) => void
}

type ResizeCursor = 'nwse' | 'nesw'

interface Internal {
  ready: (p: YTPlayer) => void
  gone: () => void
  fail: () => void
  setResizing: (cursor: ResizeCursor | null) => void
}

const NONE: HearingVideo = {
  videoId: null, canSeek: false, expanded: false, activated: false, failed: false,
  setExpanded: () => {}, seek: () => {}, cue: () => {}, seekClick: () => undefined,
  sidebarWidth: null, floatWidth: null, setSidebarWidth: () => {}, setFloatWidth: () => {},
  sidebarMax: 0, setSidebarMax: () => {},
}

/** The only shape the player ever takes — height is always derived from width. */
const ASPECT = 16 / 9

const clamp = (w: number, min: number, max: number) => Math.round(Math.min(Math.max(w, min), Math.max(min, max)))

// Resize limits. The minimums are the default sizes, so a reader can only grow
// the player from where it starts and shrink it back.
//   Sidebar: the default 15rem column (TranscriptView's grid), up to whatever
//   the page margins allow — see useSidebarBreakout.
//   Floating: ~the default mini-player, up to the window width less the page
//   gutters, and never taller than 60% of the window.
const SIDEBAR_MIN = 240
/** Keep this much clear of the viewport edge — the page's own px-4 gutter. */
const EDGE_GUTTER = 16
const clampFloat = (w: number) =>
  clamp(w, Math.min(240, window.innerWidth - 32), Math.min(720, window.innerWidth - 32, window.innerHeight * 0.6 * ASPECT))

const Ctx = createContext<HearingVideo>(NONE)
const InternalCtx = createContext<Internal | null>(null)

export const useHearingVideo = () => useContext(Ctx)

export function HearingVideoProvider({ videoUrl, children }: { videoUrl: string | null | undefined; children: ReactNode }) {
  const videoId = youtubeVideoId(videoUrl)
  const isDesktop = useIsDesktop()

  // The reader's choice, remembered for as long as they are on the page. Until
  // they make one: shown beside the outline on desktop, tucked away on mobile
  // where it would sit over the text.
  const [choice, setChoice] = useState<boolean | null>(null)
  const expanded = choice ?? isDesktop
  const [activated, setActivated] = useState(expanded)
  useEffect(() => { if (expanded) setActivated(true) }, [expanded])

  const [failed, setFailed] = useState(false)

  // Remembered while on the page, like the collapsed/expanded choice.
  const [sidebarWidth, setSidebarWidth] = useState<number | null>(null)
  const [floatWidth, setFloatWidth] = useState<number | null>(null)
  const [sidebarMax, setSidebarMax] = useState(SIDEBAR_MIN)
  // While a grip is being dragged the iframe must not eat pointer events —
  // otherwise a fast drag that crosses the video stalls the resize.
  const [resizing, setResizing] = useState<ResizeCursor | null>(null)

  const player = useRef<YTPlayer | null>(null)
  const pending = useRef<number | null>(null)
  const cued = useRef<number | null>(null)
  const videoIdRef = useRef(videoId)
  videoIdRef.current = videoId

  const play = (p: YTPlayer, seconds: number) => {
    p.seekTo(seconds, true)
    p.playVideo()
  }

  const setExpanded = useCallback((v: boolean) => {
    setChoice(v)
    // Collapsing shouldn't leave the hearing talking from an invisible player.
    if (!v) player.current?.pauseVideo()
  }, [])

  const seek = useCallback((ms: number) => {
    const seconds = Math.max(0, Math.floor(ms / 1000))
    cued.current = null
    setChoice(true)
    if (player.current) play(player.current, seconds)
    else pending.current = seconds
  }, [])

  const cue = useCallback((ms: number) => {
    const seconds = Math.max(0, Math.floor(ms / 1000))
    cued.current = seconds
    const id = videoIdRef.current
    if (player.current && id) player.current.cueVideoById({ videoId: id, startSeconds: seconds })
  }, [])

  const canSeek = !!videoId && !failed

  const seekClick = useCallback((ms: number) => {
    if (!canSeek) return undefined
    return (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      e.preventDefault()
      seek(ms)
    }
  }, [canSeek, seek])

  const internal = useMemo<Internal>(() => ({
    ready: (p) => {
      player.current = p
      if (pending.current != null) {
        play(p, pending.current)
        pending.current = null
      } else if (cued.current != null && videoIdRef.current) {
        p.cueVideoById({ videoId: videoIdRef.current, startSeconds: cued.current })
      }
    },
    gone: () => { player.current = null },
    fail: () => {
      player.current = null
      pending.current = null
      setFailed(true)
    },
    setResizing,
  }), [])

  const value = useMemo<HearingVideo>(
    () => ({
      videoId, canSeek, expanded, activated, failed, setExpanded, seek, cue, seekClick,
      sidebarWidth, floatWidth, setSidebarWidth, setFloatWidth, sidebarMax, setSidebarMax,
    }),
    [videoId, canSeek, expanded, activated, failed, setExpanded, seek, cue, seekClick, sidebarWidth, floatWidth, sidebarMax],
  )

  return (
    <Ctx.Provider value={value}>
      <InternalCtx.Provider value={internal}>
        {children}
        {/* Full-page shield while resizing: keeps the drag's pointer events in
            this document even when the cursor crosses the YouTube iframe, and
            holds the resize cursor steady wherever the pointer goes. */}
        {resizing && (
          <div
            aria-hidden
            className={cn('fixed inset-0 z-[100]', resizing === 'nwse' ? 'cursor-nwse-resize' : 'cursor-nesw-resize')}
          />
        )}
      </InternalCtx.Provider>
    </Ctx.Provider>
  )
}

/**
 * A corner grip that scales the player proportionally. Only a WIDTH is ever
 * produced; the frame's height follows from `aspect-video`, so no drag can
 * distort, stretch or letterbox the video. Diagonal drags use whichever axis
 * moved further (the vertical converted to width at 16:9), so the grip tracks
 * the pointer whether you pull sideways, down, or corner-wise.
 *
 * `corner` is the corner the grip sits in; dragging away from the player grows
 * it. `xGain` is how much width one pixel of horizontal drag is worth — 1 when
 * only the grip's edge moves (the floating player, pinned top-right), 2 when
 * the player grows from both sides at once (the sidebar breakout, where the
 * left edge moves out half the growth and the transcript shifts the other
 * half), so the grip stays under the pointer either way.
 */
function ResizeGrip({ corner, width, onResize, limit, xGain = 1 }: {
  corner: 'bottom-right' | 'bottom-left'
  /** The current rendered width, for keyboard steps (dragging measures live). */
  width: () => number
  onResize: (w: number) => void
  limit: (w: number) => number
  xGain?: number
}) {
  const internal = useContext(InternalCtx)
  const dir = corner === 'bottom-right' ? 1 : -1

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const x0 = e.clientX
    const y0 = e.clientY
    const w0 = width()
    internal?.setResizing(dir === 1 ? 'nwse' : 'nesw')

    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) * dir * xGain
      const dy = (ev.clientY - y0) * ASPECT
      onResize(limit(w0 + (Math.abs(dx) >= Math.abs(dy) ? dx : dy)))
    }
    const stop = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      internal?.setResizing(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }

  // Keyboard: arrows grow/shrink in the direction the grip points.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 96 : 32
    const grow = { ArrowRight: dir, ArrowLeft: -dir, ArrowDown: 1, ArrowUp: -1 }[e.key]
    if (grow == null) return
    e.preventDefault()
    onResize(limit(width() + grow * step))
  }

  return (
    <button
      type="button"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      title="Drag to resize"
      aria-label="Resize video (arrow keys)"
      className={cn(
        'flex h-5 w-5 shrink-0 touch-none items-center justify-center text-slate-400 transition-colors hover:text-slate-800',
        corner === 'bottom-right' ? 'cursor-nwse-resize' : 'cursor-nesw-resize',
      )}
    >
      {/* Three diagonal ticks, mirrored to point into the corner that moves. */}
      <svg viewBox="0 0 10 10" className={cn('h-2.5 w-2.5', corner === 'bottom-left' && '-scale-x-100')} aria-hidden>
        <path d="M9 1 1 9M9 4.5 4.5 9M9 8 8 9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />
      </svg>
    </button>
  )
}

/**
 * The desktop layout for a resized sidebar player: the player grows by pushing
 * the transcript RIGHT, never by narrowing it.
 *
 * The page content sits in a centred container. When the player grows by Δ the
 * two-column grid breaks out of that container by Δ/2 on each side (negative
 * margins): the sidebar's left edge moves out into the left margin by Δ/2 and
 * the transcript column slides right by Δ/2. The transcript's width is
 * container − default sidebar − gap, identical to the default layout, so the
 * reading measure never changes.
 *
 * The limit is where either side would reach the viewport gutter — equivalently
 * where the transcript is pushed flush against the right edge — so a wide
 * monitor (big margins) allows a big player and a window no wider than the
 * container allows no growth at all. Also capped at 55% of the window height,
 * so the outline keeps room above it in the sticky sidebar.
 *
 * `shellRef` is an element spanning the container's full width (NOT the grid,
 * whose own box moves with the breakout). Returns the grid's inline style.
 */
export function useSidebarBreakout(shellRef: RefObject<HTMLElement>, enabled: boolean): CSSProperties | undefined {
  const { sidebarWidth, sidebarMax, setSidebarMax, expanded } = useHearingVideo()

  useLayoutEffect(() => {
    if (!enabled) return
    const measure = () => {
      const r = shellRef.current?.getBoundingClientRect()
      if (!r) return
      const vw = document.documentElement.clientWidth
      const room = Math.max(0, Math.min(r.left, vw - r.right) - EDGE_GUTTER)
      setSidebarMax(Math.max(SIDEBAR_MIN, Math.floor(Math.min(SIDEBAR_MIN + 2 * room, window.innerHeight * 0.55 * ASPECT))))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [enabled, shellRef, setSidebarMax])

  // A hidden player shows only its "Show ▾" header, so the layout returns to
  // normal until it is shown again (at the remembered size).
  if (!enabled || !expanded || sidebarWidth == null) return undefined
  const w = clamp(sidebarWidth, SIDEBAR_MIN, sidebarMax)
  const half = (w - SIDEBAR_MIN) / 2
  if (half <= 0) return undefined
  return { gridTemplateColumns: `${w}px minmax(0, 1fr)`, marginLeft: -half, marginRight: -half }
}

/** The 16:9 iframe itself. Mount exactly one per page (see HearingVideoSlot). */
function HearingVideoFrame({ videoId }: { videoId: string }) {
  const internal = useContext(InternalCtx)
  const { failed } = useHearingVideo()
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host || !internal) return
    let cancelled = false
    let created: YTPlayer | null = null

    // YouTube replaces the element it is given with its iframe, so give it a
    // throwaway child rather than a node React is tracking.
    const target = document.createElement('div')
    host.appendChild(target)

    loadYouTubeIframeApi()
      .then((YT) => {
        if (cancelled) return
        created = new YT.Player(target, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
          events: {
            onReady: (e) => { if (!cancelled) internal.ready(e.target) },
            // 101/150: the uploader disallows embedding; 100: removed/private.
            onError: (e) => { if (!cancelled && [100, 101, 150].includes(e.data)) internal.fail() },
          },
        })
      })
      .catch(() => { if (!cancelled) internal.fail() })

    return () => {
      cancelled = true
      internal.gone()
      created?.destroy()
      host.replaceChildren()
    }
  }, [videoId, internal])

  return (
    <div className="relative aspect-video w-full bg-slate-900">
      <div ref={hostRef} className="absolute inset-0 [&>iframe]:h-full [&>iframe]:w-full" />
      {failed && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-900 p-3 text-center">
          <a
            href={youtubeWatchAt(videoId, 0) ?? undefined}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-slate-200 underline underline-offset-2 hover:text-white"
          >
            This video can’t play here — open it on YouTube
          </a>
        </div>
      )}
    </div>
  )
}

/**
 * The frame, lazily created on first show and then kept alive while collapsed
 * (hidden, not unmounted) so reopening resumes where the reader left off.
 */
function HearingVideoSlot({ className, style, footer }: {
  className?: string
  style?: CSSProperties
  /** A strip under the video for controls — kept OFF the frame so it never
   *  covers YouTube's own play/fullscreen buttons in the bottom corners. */
  footer?: ReactNode
}) {
  const { videoId, activated, expanded } = useHearingVideo()
  if (!videoId || !activated) return null
  return (
    <div hidden={!expanded} className={className} style={style}>
      <HearingVideoFrame videoId={videoId} />
      {footer}
    </div>
  )
}

/**
 * The desktop sidebar card (and, with `resizable` off, the inline card for an
 * unsectioned hearing). Its width IS the sidebar column's width — resizing sets
 * `sidebarWidth`, which useSidebarBreakout turns into the grid layout — so the
 * sidebar grows out to the left and the transcript slides right, same width.
 */
export function HearingVideoPanel({ className, resizable }: { className?: string; resizable?: boolean }) {
  const { videoId, expanded, setExpanded, setSidebarWidth, sidebarMax } = useHearingVideo()
  const ref = useRef<HTMLElement>(null)
  if (!videoId) return null
  return (
    <section
      ref={ref}
      aria-label="Hearing video"
      className={cn('overflow-hidden rounded-lg border border-gray-200 bg-white', className)}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-slate-50 transition-colors"
      >
        <span aria-hidden className="text-[9px] text-slate-500">▶</span>
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">Video</span>
        <span className="ml-auto text-xs text-slate-500">{expanded ? 'Hide ▴' : 'Show ▾'}</span>
      </button>
      <HearingVideoSlot
        footer={resizable && (
          <div className="flex border-t border-gray-100">
            <ResizeGrip
              corner="bottom-left"
              xGain={2}
              width={() => ref.current?.getBoundingClientRect().width ?? SIDEBAR_MIN}
              onResize={setSidebarWidth}
              limit={(w) => clamp(w, SIDEBAR_MIN, sidebarMax)}
            />
            {sidebarMax <= SIDEBAR_MIN && (
              // Tell the reader why the grip does nothing, rather than letting it feel broken.
              <span className="self-center pr-2 ml-auto text-[10px] text-slate-400">Widen the window to enlarge</span>
            )}
          </div>
        )}
      />
    </section>
  )
}

/**
 * The floating player for layouts without the sidebar (a narrowed desktop
 * window, or a phone): a card hanging off the sticky section bar's top-right
 * corner, over the transcript. It carries its own Hide — same effect as the
 * bar's "▶ Video" toggle (pause + tuck away), which brings it back — and a
 * bottom-left grip, since it is anchored top-right and grows leftward/down.
 */
export function HearingVideoFloating({ className }: { className?: string }) {
  const { setExpanded, floatWidth, setFloatWidth } = useHearingVideo()
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div
      ref={ref}
      // Until the reader resizes it: two-thirds of a phone, capped on wider windows.
      className={cn(className, !floatWidth && 'w-2/3 max-w-xs')}
      style={floatWidth ? { width: `min(${floatWidth}px, calc(100vw - 2rem))` } : undefined}
    >
      <HearingVideoSlot
        className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg"
        footer={
          <div className="flex items-center border-t border-gray-100">
            <ResizeGrip
              corner="bottom-left"
              width={() => ref.current?.getBoundingClientRect().width ?? 240}
              onResize={setFloatWidth}
              limit={clampFloat}
            />
            <button
              onClick={() => setExpanded(false)}
              aria-label="Hide video"
              title="Hide video (▶ Video in the bar brings it back)"
              className="ml-auto px-2 py-0.5 text-xs text-slate-500 transition-colors hover:text-slate-900"
            >
              Hide <span aria-hidden>×</span>
            </button>
          </div>
        }
      />
    </div>
  )
}
