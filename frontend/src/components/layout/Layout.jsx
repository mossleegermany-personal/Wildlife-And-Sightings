import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import '../../css/components/Layout.css'
import Header from './Header'
import Body from './Body'
import AdminModal from '../ui/AdminModal'

function Layout() {
  const [modalOpen, setModalOpen] = useState(false)
  const [isAdmin, setIsAdmin] = useState(!!localStorage.getItem('adminAuth'))
  const navigate = useNavigate()

  function handleSecretClick() {
    if (isAdmin) {
      localStorage.removeItem('adminAuth')
      setIsAdmin(false)
      navigate('/')
    } else {
      setModalOpen(true)
    }
  }

  function handleLoginSuccess() {
    setIsAdmin(true)
  }

  return (
    <div className="layout">
      <Header onSecretClick={handleSecretClick} isAdmin={isAdmin} />
      <Body />
      <AdminModal open={modalOpen} onClose={() => setModalOpen(false)} onSuccess={handleLoginSuccess} />
    </div>
  )
}

export default Layout
