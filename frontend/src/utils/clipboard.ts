// Clipboard writes for share links.
//
// Browsers only allow a clipboard write inside the user's click. A share link
// comes from an async POST, so by the time the URL exists the click is over —
// and Safari then refuses writeText. The supported route is to hand the
// clipboard a PROMISE of the content, synchronously, inside the click:
// ClipboardItem accepts one. Where that isn't available we fall back to
// writeText after the fact (fine in Chromium/Firefox), and failing that the
// caller shows the URL for the reader to copy by hand.

export interface CopyResult {
  /** The text that was (or should have been) copied. */
  text: string
  /** False → nothing reached the clipboard; show `text` for manual copying. */
  copied: boolean
}

/**
 * Copy text that is still being produced. MUST be called synchronously from
 * the click handler (before any await). Rejects only if `pending` itself
 * rejects — i.e. the link could not be created — never for clipboard refusal.
 */
export async function copyPending(pending: Promise<string>): Promise<CopyResult> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      // Starts the write NOW, inside the gesture; the blob resolves later.
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/plain': pending.then((t) => new Blob([t], { type: 'text/plain' })) }),
      ])
      return { text: await pending, copied: true }
    } catch {
      // Either the link failed (surfaced below) or this browser refused the
      // promise form — fall through to writeText.
    }
  }
  const text = await pending
  return { text, copied: await copyText(text) }
}

/** Copy text that already exists. Resolves false instead of throwing. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
