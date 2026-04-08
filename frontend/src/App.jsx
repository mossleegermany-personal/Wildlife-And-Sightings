import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/layout/Layout'
import Admin from './pages/Admin'
import Home from './pages/Home'
import './css/components/Layout.css'

function ProtectedAdmin() {
  if (!localStorage.getItem('adminAuth')) return <Navigate to="/" replace />
  return <Admin />
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/admin" element={<ProtectedAdmin />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
