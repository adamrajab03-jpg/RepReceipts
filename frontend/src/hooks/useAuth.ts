import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuthStore, type AuthUser } from '../store/authStore'
import { fetchCsrfToken } from '../utils/apiFetch'

// ── /me ───────────────────────────────────────────────────────────────────────
async function fetchMe(): Promise<AuthUser | null> {
  const res = await fetch('/api/auth/me'); // GET — no CSRF needed
  if (res.status === 401) return null;
  if (!res.ok) throw new Error('Failed to fetch current user');
  const { user } = await res.json();
  return user as AuthUser;
}

export function useMe() {
  const setUser = useAuthStore(s => s.setUser);
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      const user = await fetchMe();
      setUser(user);
      return user;
    },
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

// ── Register ──────────────────────────────────────────────────────────────────
interface RegisterInput { handle: string; email: string; password: string }

export function useRegister() {
  const setUser = useAuthStore(s => s.setUser);
  const qc      = useQueryClient();

  return useMutation({
    mutationFn: async (input: RegisterInput) => {
      const token = await fetchCsrfToken();
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify(input),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Registration failed');
      return body.user as AuthUser;
    },
    onSuccess: (user) => {
      setUser(user);
      qc.setQueryData(['me'], user);
    },
  });
}

// ── Login ─────────────────────────────────────────────────────────────────────
interface LoginInput { email: string; password: string }

export function useLogin() {
  const setUser = useAuthStore(s => s.setUser);
  const qc      = useQueryClient();

  return useMutation({
    mutationFn: async (input: LoginInput) => {
      const token = await fetchCsrfToken();
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
        body: JSON.stringify(input),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Login failed');
      return body.user as AuthUser;
    },
    onSuccess: (user) => {
      setUser(user);
      qc.setQueryData(['me'], user);
    },
  });
}

// ── Logout ────────────────────────────────────────────────────────────────────
export function useLogout() {
  const setUser = useAuthStore(s => s.setUser);
  const qc      = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const token = await fetchCsrfToken();
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'X-CSRF-Token': token },
      });
    },
    onSuccess: () => {
      setUser(null);
      qc.clear();
    },
  });
}
