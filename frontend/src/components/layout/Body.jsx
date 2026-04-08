import { Outlet } from 'react-router-dom'
import Footer from './Footer'

function Body() {
  return (
    <main className="site-body">
      <Outlet />
      <Footer />
    </main>
  )
}

export default Body
