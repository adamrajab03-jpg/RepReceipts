import { NavLink, Outlet, Link, useLocation } from 'react-router-dom'
import { cn } from '../utils/cn'
import { useAuthStore } from '../store/authStore'
import { useLogout } from '../hooks/useAuth'
import NotificationBell from './NotificationBell'
import ZipSearch from './ZipSearch'

export default function Layout() {
  const user   = useAuthStore(s => s.user)
  const logout = useLogout()
  const { pathname } = useLocation()

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-slate-900 text-white shadow-lg">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-6">
          <span className="font-bold text-lg tracking-tight">Rep Receipts</span>

          <NavLink
            to="/members"
            className={({ isActive }) =>
              cn('text-sm font-medium transition-colors hover:text-white',
                isActive ? 'text-white' : 'text-slate-400')
            }
          >
            Members
          </NavLink>

          <NavLink
            to="/hearings"
            className={({ isActive }) =>
              cn('text-sm font-medium transition-colors hover:text-white',
                isActive ? 'text-white' : 'text-slate-400')
            }
          >
            Hearings
          </NavLink>

          <NavLink
            to="/heatmap"
            className={({ isActive }) =>
              cn('text-sm font-medium transition-colors hover:text-white',
                isActive ? 'text-white' : 'text-slate-400')
            }
          >
            Heat Map
          </NavLink>

          {user && (
            <NavLink
              to="/following"
              className={({ isActive }) =>
                cn('text-sm font-medium transition-colors hover:text-white',
                  isActive ? 'text-white' : 'text-slate-400')
              }
            >
              Following
            </NavLink>
          )}

          <div className="ml-auto flex items-center gap-4">
            {/* Compact ZIP search on every page except the homepage (which has the hero). */}
            {pathname !== '/' && <ZipSearch />}
            {user ? (
              <>
                <NotificationBell />
                <span className="text-sm text-slate-300">@{user.handle}</span>
                <button
                  onClick={() => logout.mutate()}
                  disabled={logout.isPending}
                  className="text-sm text-slate-400 hover:text-white transition-colors disabled:opacity-50"
                >
                  {logout.isPending ? 'Signing out…' : 'Sign out'}
                </button>
              </>
            ) : (
              <>
                <Link to="/login"    className="text-sm text-slate-400 hover:text-white transition-colors">Sign in</Link>
                <Link to="/register" className="text-sm bg-slate-700 hover:bg-slate-600 transition-colors px-3 py-1.5 rounded-lg">Register</Link>
              </>
            )}
          </div>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-4 py-8">
        <Outlet />
      </main>
    </div>
  )
}
