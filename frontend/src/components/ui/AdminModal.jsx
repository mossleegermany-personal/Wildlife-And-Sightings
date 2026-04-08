import { Component } from 'react'
import '../../css/components/AdminModal.css'

const ADMIN_PASSWORD = import.meta.env.VITE_ADMIN_PASSWORD || 'wildlife2026'

class AdminModalInner extends Component {
  constructor(props) {
    super(props)
    this.state = {
      password: '',
      error: '',
      visible: false,
    }
    this.handleSubmit = this.handleSubmit.bind(this)
    this.handleClose = this.handleClose.bind(this)
    this.handleKeyDown = this.handleKeyDown.bind(this)
  }

  handleSubmit(e) {
    e.preventDefault()
    if (this.state.password === ADMIN_PASSWORD) {
      this.setState({ error: '', password: '' })
      this.props.onSuccess()
    } else {
      this.setState({ error: 'Incorrect password', password: '' })
    }
  }

  handleClose() {
    this.setState({ password: '', error: '' })
    this.props.onClose()
  }

  handleKeyDown(e) {
    if (e.key === 'Escape') this.handleClose()
  }

  render() {
    const { open } = this.props
    const { password, error } = this.state

    if (!open) return null

    return (
      <div className="admin-modal__overlay" onClick={this.handleClose} onKeyDown={this.handleKeyDown} tabIndex={-1}>
        <div className="admin-modal__box" onClick={(e) => e.stopPropagation()}>
          <div className="admin-modal__header">
            <span className="admin-modal__title">Admin Access</span>
            <button className="admin-modal__close" onClick={this.handleClose} aria-label="Close">✕</button>
          </div>
          <form className="admin-modal__body" onSubmit={this.handleSubmit}>
            <label className="admin-modal__label" htmlFor="admin-password">Password</label>
            <input
              id="admin-password"
              className={`admin-modal__input${error ? ' admin-modal__input--error' : ''}`}
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => this.setState({ password: e.target.value, error: '' })}
              placeholder="Enter admin password"
            />
            {error && <span className="admin-modal__error">{error}</span>}
            <button className="admin-modal__submit" type="submit">Enter</button>
          </form>
        </div>
      </div>
    )
  }
}

export default function AdminModal(props) {
  function handleSuccess() {
    localStorage.setItem('adminAuth', '1')
    props.onSuccess?.()
    props.onClose()
  }

  return <AdminModalInner {...props} onSuccess={handleSuccess} />
}
