import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useMe } from './hooks/useAuth'
import Layout from './components/Layout'
import MembersPage from './pages/MembersPage'
import MemberProfilePage from './pages/MemberProfilePage'
import HearingsPage from './pages/HearingsPage'
import HearingTranscriptPage from './pages/HearingTranscriptPage'
import HeatMapPage from './pages/HeatMapPage'
import FollowingPage from './pages/FollowingPage'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'

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
          <Route index element={<Navigate to="/members" replace />} />
          <Route path="members"     element={<MembersPage />} />
          <Route path="members/:id" element={<MemberProfilePage />} />
          <Route path="hearings"    element={<HearingsPage />} />
          <Route path="hearings/:id" element={<HearingTranscriptPage />} />
          <Route path="heatmap"     element={<HeatMapPage />} />
          <Route path="following"   element={<FollowingPage />} />
          <Route path="login"       element={<LoginPage />} />
          <Route path="register"    element={<RegisterPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
