export async function fetchCsrfToken(): Promise<string> {
  const res = await fetch('/api/auth/csrf');
  const data = await res.json();
  return data.token as string;
}

// Wraps fetch with automatic fresh CSRF token injection for mutating requests.
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const method   = (init.method ?? 'GET').toUpperCase();
  const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined ?? {}),
  };

  if (mutating) {
    headers['X-CSRF-Token'] = await fetchCsrfToken();
  }

  return fetch(url, { ...init, headers });
}
