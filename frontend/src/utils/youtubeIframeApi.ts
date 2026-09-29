// ============================================================================
//  YouTube IFrame Player API — loaded once, on demand.
// ----------------------------------------------------------------------------
//  The API is a global script that announces itself through a single global
//  callback (window.onYouTubeIframeAPIReady). We load it at most once per page
//  life, chain any callback someone else already installed rather than
//  clobbering it, and hand every caller the same promise. A failed load (an ad
//  blocker, offline) clears the promise so a later mount can try again.
//
//  Only the handful of player methods we actually call are typed here — not
//  worth a @types dependency.
// ============================================================================

export interface YTPlayer {
  seekTo(seconds: number, allowSeekAhead: boolean): void
  playVideo(): void
  pauseVideo(): void
  destroy(): void
}

interface YTPlayerOptions {
  videoId: string
  width?: string | number
  height?: string | number
  playerVars?: Record<string, string | number>
  events?: {
    onReady?: (e: { target: YTPlayer }) => void
    onError?: (e: { target: YTPlayer; data: number }) => void
  }
}

interface YTNamespace {
  Player: new (el: HTMLElement, opts: YTPlayerOptions) => YTPlayer
}

declare global {
  interface Window {
    YT?: YTNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

const SRC = 'https://www.youtube.com/iframe_api'
let apiPromise: Promise<YTNamespace> | null = null

export function loadYouTubeIframeApi(): Promise<YTNamespace> {
  if (apiPromise) return apiPromise

  apiPromise = new Promise<YTNamespace>((resolve, reject) => {
    if (window.YT?.Player) {
      resolve(window.YT)
      return
    }

    const prev = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      prev?.()
      if (window.YT?.Player) resolve(window.YT)
      else reject(new Error('YouTube IFrame API loaded without YT.Player'))
    }

    // Someone (a previous, failed attempt aside) may already have added the tag.
    if (document.querySelector(`script[src="${SRC}"]`)) return

    const script = document.createElement('script')
    script.src = SRC
    script.async = true
    script.onerror = () => {
      script.remove()
      apiPromise = null
      reject(new Error('YouTube IFrame API failed to load'))
    }
    document.head.appendChild(script)
  })

  return apiPromise
}
