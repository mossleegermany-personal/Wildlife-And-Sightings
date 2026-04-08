import { NavLink } from 'react-router-dom'

function Header({ onSecretClick, isAdmin }) {

  return (
    <header className="site-header">
      <div className="site-header__top">
        <span className="site-header__logo">
          Wildlife{' '}
          <span className="site-header__logo-secret" onClick={onSecretClick}>&amp;</span>
          {' '}Sightings
        </span>
      </div>
      <div className="site-header__nav-bar">
        <nav className="site-header__nav">
          <NavLink to="/" end>Home</NavLink>
          {isAdmin && <NavLink to="/admin">Admin</NavLink>}
        </nav>
      </div>
    </header>
  )
}

export default Header
