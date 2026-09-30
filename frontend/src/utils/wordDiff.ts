// Word-level diff for a shared quote's "View the original": what the passage
// said when it was shared vs what it says now. Words compare EXACTLY —
// punctuation and capitalisation included — because a formatting-only change
// is still a change a reader is entitled to see.

export interface DiffOp {
  type: 'same' | 'del' | 'ins'
  text: string
}

export function wordDiff(before: string, after: string): DiffOp[] {
  const a = before.split(/\s+/).filter(Boolean)
  const b = after.split(/\s+/).filter(Boolean)
  const W = b.length + 1
  // LCS table, bottom-up. Quotes are capped at 1,200 chars, so this is tiny.
  const L = new Uint16Array((a.length + 1) * W)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      L[i * W + j] = a[i] === b[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1])
    }
  }

  const ops: DiffOp[] = []
  const push = (type: DiffOp['type'], word: string) => {
    const last = ops[ops.length - 1]
    if (last?.type === type) last.text += ` ${word}`
    else ops.push({ type, text: word })
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push('same', a[i]); i++; j++ }
    else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) push('del', a[i++])
    else push('ins', b[j++])
  }
  while (i < a.length) push('del', a[i++])
  while (j < b.length) push('ins', b[j++])
  return ops
}
