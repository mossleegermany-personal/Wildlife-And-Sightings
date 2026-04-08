/**
 * TabNav
 * Renders a horizontal tab bar.
 * @param {{ tabs: { id: string, label: string }[], active: string, onChange: (id: string) => void }} props
 */
import '../../css/components/TabNav.css'

function TabNav({ tabs, active, onChange }) {
  return (
    <nav className="tab-nav">
      {tabs.map((t) => (
        <button
          key={t.id}
          className={`tab-btn${active === t.id ? ' tab-btn--active' : ''}`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  )
}

export default TabNav
