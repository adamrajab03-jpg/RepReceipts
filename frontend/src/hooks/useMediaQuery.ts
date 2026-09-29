import { useCallback, useSyncExternalStore } from 'react'

/** Live `matchMedia` result — re-renders when the query flips (resize, rotation). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    [query],
  )
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false)
}

/** Tailwind's `lg` breakpoint — where the transcript gets its sidebar. */
export const useIsDesktop = () => useMediaQuery('(min-width: 1024px)')
