import { useEffect, useState } from 'react'

/**
 * Track which anchor the reader is currently inside, for a scroll-spy nav.
 *
 * `ids` must be in document order. The active anchor is the LAST one whose top
 * has passed the reading line (`offset` px below the viewport top) — the same
 * rule a reader applies: you are in the section whose header you last scrolled
 * past, even when the next header is nowhere near the screen.
 *
 * The IntersectionObserver is only a trigger, not the answer: it fires whenever
 * any anchor crosses the line, and the callback then measures all of them. That
 * avoids the classic scroll-spy gap where a section taller than the viewport
 * leaves no element "intersecting" and the highlight drops off entirely.
 */
export function useActiveAnchor(ids: string[], offset = 96): string | null {
  const [active, setActive] = useState<string | null>(null)
  const key = ids.join('|')

  useEffect(() => {
    const els = (key ? key.split('|') : [])
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null)

    if (!els.length) { setActive(null); return }

    const pick = () => {
      let current = els[0].id
      for (const el of els) {
        if (el.getBoundingClientRect().top - offset <= 0) current = el.id
        else break
      }
      setActive(current)
    }

    const io = new IntersectionObserver(pick, { rootMargin: `-${offset}px 0px 0px 0px`, threshold: 0 })
    els.forEach((el) => io.observe(el))
    pick()
    window.addEventListener('resize', pick)
    return () => { io.disconnect(); window.removeEventListener('resize', pick) }
  }, [key, offset])

  return active
}
