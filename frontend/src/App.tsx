import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import MembersPage from './pages/MembersPage'
import MemberProfilePage from './pages/MemberProfilePage'
import HearingsPage from './pages/HearingsPage'
import HearingTranscriptPage from './pages/HearingTranscriptPage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/members" replace />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="members/:id" element={<MemberProfilePage />} />
          <Route path="hearings" element={<HearingsPage />} />
          <Route path="hearings/:id" element={<HearingTranscriptPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
