import { create } from 'zustand'

interface TranscriptStore {
  activeTurnId: string | null
  activeWordMs: number | null
  setActiveTurn: (id: string | null) => void
  seekTo: (ms: number) => void
}

export const useTranscriptStore = create<TranscriptStore>((set) => ({
  activeTurnId: null,
  activeWordMs: null,
  setActiveTurn: (id) => set({ activeTurnId: id }),
  seekTo: (ms) => set({ activeWordMs: ms }),
}))
