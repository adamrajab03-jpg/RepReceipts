import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { useMe } from './hooks/useAuth'
import Layout from './components/Layout'
import HomePage from './pages/HomePage'
import RepsLookupPage from './pages/RepsLookupPage'
import MembersPage from './pages/MembersPage'
import MemberProfilePage from './pages/MemberProfilePage'
import HearingsPage from './pages/HearingsPage'
import HearingTranscriptPage from './pages/HearingTranscriptPage'
import HeatMapPage from './pages/HeatMapPage'
import FollowingPage from './pages/FollowingPage'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import AdminRoute from './components/AdminRoute'
import AdminDashboardPage from './pages/AdminDashboardPage'
import ReviewWorkbenchPage from './pages/ReviewWorkbenchPage'

// Fetches /me on mount and syncs result into Zustand auth store
function AuthInit() {
  useMe()
  return null
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthInit />
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<HomePage />} />
          <Route path="reps"        element={<RepsLookupPage />} />
          <Route path="members"     element={<MembersPage />} />
          <Route path="members/:id" element={<MemberProfilePage />} />
          <Route path="hearings"    element={<HearingsPage />} />
          <Route path="hearings/:id" element={<HearingTranscriptPage />} />
          <Route path="heatmap"     element={<HeatMapPage />} />
          <Route path="following"   element={<FollowingPage />} />
          <Route path="login"       element={<LoginPage />} />
          <Route path="register"    element={<RegisterPage />} />

          <Route path="admin" element={<AdminRoute />}>
            <Route index element={<AdminDashboardPage />} />
            <Route path="hearings/:id/review" element={<ReviewWorkbenchPage />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
