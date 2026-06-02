import { NavLink, Outlet } from 'react-router-dom'
import { cn } from '../utils/cn'

export default function Layout() {
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
        </div>
      </nav>
      <main className="max-w-6xl mx-auto px-4 py-8">
        <Outlet />
      </main>
    </div>
  )
}
