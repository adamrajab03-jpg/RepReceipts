// ============================================================================
//  YouTube URL helpers for deep-linking the hearing video at a timestamp.
// ----------------------------------------------------------------------------
//  hearings.video_url is whatever URL the hearing was captured from, and the
//  shape varies: a livestream is stored as /live/<id>, an archived video as
//  /watch?v=<id>, a share link as youtu.be/<id>. Never assume ?v= — the
//  hearings we have are mostly /live/ links.
// ============================================================================

/** YouTube ids are 11 chars of [A-Za-z0-9_-]. */
const ID = /^[\w-]{11}$/

/**
 * Pull the video id out of any YouTube URL shape (or a bare id).
 * Returns null for a non-YouTube URL, so callers can simply omit the link.
 */
export function youtubeVideoId(url: string | null | undefined): string | null {
  if (!url) return null
  const raw = url.trim()
  if (ID.test(raw)) return raw

  let u: URL
  try { u = new URL(raw) } catch { return null }

  const ok = (s: string | null | undefined) => (s && ID.test(s) ? s : null)
  const host = u.hostname.replace(/^www\./, '')

  if (host === 'youtu.be') return ok(u.pathname.split('/')[1])
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'youtube-nocookie.com') return null

  const [, first, second] = u.pathname.split('/')
  // /live/<id> · /embed/<id> · /shorts/<id> · /v/<id>
  if (first === 'live' || first === 'embed' || first === 'shorts' || first === 'v') return ok(second)
  // /watch?v=<id> — and any other path that still carries ?v=
  return ok(u.searchParams.get('v'))
}

/**
 * A watch URL that starts playback `ms` into the video, e.g.
 * https://www.youtube.com/watch?v=uttPqNWzEMs&t=1172s
 *
 * Whole seconds — YouTube ignores fractions, and a section's start is a spoken
 * word, not a frame. Returns null when the hearing has no usable video URL.
 */
export function youtubeWatchAt(url: string | null | undefined, ms: number | null | undefined): string | null {
  const id = youtubeVideoId(url)
  if (!id) return null
  const base = `https://www.youtube.com/watch?v=${id}`
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return base
  return `${base}&t=${Math.floor(ms / 1000)}s`
}
