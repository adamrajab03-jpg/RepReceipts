import { create } from 'zustand'

export interface AuthUser {
  id: string
  handle: string
  email: string
  is_admin: boolean
  email_verified: boolean
}

interface AuthStore {
  user: AuthUser | null
  setUser: (user: AuthUser | null) => void
}

export const useAuthStore = create<AuthStore>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
}))
