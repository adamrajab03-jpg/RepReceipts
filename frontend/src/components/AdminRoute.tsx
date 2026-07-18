import { Navigate, Outlet } from 'react-router-dom'
import { useMe } from '../hooks/useAuth'
import { useAuthStore } from '../store/authStore'

// Gate for /admin/*. Waits for the /me query to resolve before deciding, so a
// logged-in admin doesn't get a flash-redirect on a hard page load. Non-admins
// (and anonymous visitors) are sent home — clean, no crash.
export default function AdminRoute() {
  const { isLoading } = useMe()
  const user = useAuthStore((s) => s.user)

  if (isLoading) {
    return <div className="py-16 text-center text-sm text-gray-400">Loading…</div>
  }
  if (!user?.is_admin) {
    return <Navigate to="/" replace />
  }
  return <Outlet />
}
