// ============================================================================
//  Drag a section boundary to a turn, with edge auto-scroll.
// ----------------------------------------------------------------------------
//  A boundary IS a section's start turn, so a drag resolves to one turn id and
//  one PATCH. No drag library: pointer events + setPointerCapture, which keeps
//  every move event coming to the handle even when the cursor leaves it — that
//  is what makes the header track the cursor instead of appearing to vanish.
//
//  COORDINATES: row positions are cached ONCE per drag in DOCUMENT space
//  (rect.top + scrollY), not viewport space. Viewport coordinates go stale the
//  moment the page scrolls, which would make the drop indicator point at the
//  wrong turn during auto-scroll. Document coordinates are scroll-invariant, so
//  one measurement stays correct however far the page travels — and costs no
//  layout reads per frame. This is safe because the drop indicator is
//  layout-neutral (zero-height, absolutely-positioned children), so nothing
//  reflows mid-drag.
//
//  The candidate turn is CLAMPED to the window between the neighbouring
//  boundaries, so neither dragging nor auto-scrolling can leave a section with
//  zero turns. The server re-checks the identical window; this is convenience,
//  that is the authority.
// ============================================================================
import { useCallback, useEffect, useRef, useState } from 'react'

/** Distance from a viewport edge at which auto-scroll kicks in. */
const EDGE_ZONE = 60
/** Scroll speed in px/frame at the very edge; ramps to 0 at the zone boundary. */
const MAX_SPEED = 22

export interface DragState {
  sectionId: string
  /** Turn seq the boundary would land on if released now (already clamped). */
  seq: number
  /** Legal window, inclusive — the boundary cannot land outside it. */
  min: number
  max: number
}

interface StartArgs {
  sectionId: string
  currentSeq: number
  min: number
  max: number
}

/** Cached row geometry in DOCUMENT space, sorted by seq. */
interface Row { seq: number; docMid: number }

export function useBoundaryDrag(onCommit: (sectionId: string, seq: number) => void) {
  const [drag, setDrag] = useState<DragState | null>(null)

  const rows = useRef<Row[]>([])
  const active = useRef<StartArgs | null>(null)
  const pointerY = useRef(0)
  const raf = useRef<number | null>(null)
  const cancelled = useRef(false)
  /** Current landing seq, mirrored outside state so commit never depends on a
   *  state updater — StrictMode invokes those twice, which would fire the
   *  mutation twice per drag. */
  const landed = useRef(0)

  const stopLoop = useCallback(() => {
    if (raf.current !== null) { cancelAnimationFrame(raf.current); raf.current = null }
  }, [])

  const measure = useCallback(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-turn-seq]'))
    const scrollY = window.scrollY
    rows.current = els
      .map((el) => {
        const r = el.getBoundingClientRect()
        return { seq: Number(el.dataset.turnSeq), docMid: r.top + scrollY + r.height / 2 }
      })
      .sort((a, b) => a.seq - b.seq)
  }, [])

  /** Which turn would the boundary land on, for a pointer at this viewport y. */
  const seqAt = useCallback((clientY: number) => {
    const a = active.current
    if (!a) return 0
    const docY = clientY + window.scrollY
    const list = rows.current
    let candidate = list.length ? list[list.length - 1].seq : a.currentSeq
    for (const r of list) {
      if (docY < r.docMid) { candidate = r.seq; break }
    }
    return Math.min(a.max, Math.max(a.min, candidate))
  }, [])

  /** Recompute the landing turn from the current pointer AND scroll position. */
  const sync = useCallback(() => {
    if (!active.current) return
    const seq = seqAt(pointerY.current)
    landed.current = seq
    setDrag((d) => (d && d.seq !== seq ? { ...d, seq } : d))
  }, [seqAt])

  // Auto-scroll runs on rAF rather than on pointermove, because a stationary
  // pointer parked in the edge zone must keep scrolling — no pointer events
  // fire while the cursor is still. Every frame re-derives the landing turn, so
  // the indicator stays accurate as the document slides underneath.
  const loop = useCallback(() => {
    if (!active.current) { raf.current = null; return }
    const y = pointerY.current
    const h = window.innerHeight

    let dy = 0
    if (y < EDGE_ZONE) dy = -MAX_SPEED * (1 - Math.max(0, y) / EDGE_ZONE)
    else if (y > h - EDGE_ZONE) dy = MAX_SPEED * (1 - Math.max(0, h - y) / EDGE_ZONE)

    if (dy !== 0) {
      const before = window.scrollY
      window.scrollBy(0, dy)
      if (window.scrollY !== before) sync() // the document moved → re-derive
    }
    raf.current = requestAnimationFrame(loop)
  }, [sync])

  const start = useCallback((e: React.PointerEvent, args: StartArgs) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    cancelled.current = false
    active.current = args
    pointerY.current = e.clientY
    landed.current = args.currentSeq
    measure()
    setDrag({ sectionId: args.sectionId, seq: args.currentSeq, min: args.min, max: args.max })
    stopLoop()
    raf.current = requestAnimationFrame(loop)
  }, [measure, loop, stopLoop])

  const move = useCallback((e: React.PointerEvent) => {
    if (!active.current) return
    pointerY.current = e.clientY
    sync()
  }, [sync])

  const finish = useCallback((commit: boolean) => {
    const a = active.current
    active.current = null          // the rAF loop bails on its next tick…
    stopLoop()                     // …and is cancelled now, so auto-scroll
    setDrag(null)                  //    cannot run on past pointerup/Escape
    if (commit && a && !cancelled.current && landed.current !== a.currentSeq) {
      onCommit(a.sectionId, landed.current)
    }
  }, [onCommit, stopLoop])

  const end = useCallback((e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId)
    finish(true)
  }, [finish])

  // Escape aborts without writing — and without leaving the page scrolling.
  useEffect(() => {
    if (!drag) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') { cancelled.current = true; finish(false) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drag, finish])

  // Never leave a frame loop running past unmount.
  useEffect(() => () => { active.current = null; stopLoop() }, [stopLoop])

  return { drag, start, move, end }
}
