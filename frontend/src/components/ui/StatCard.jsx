import '../../css/components/StatCard.css'

function StatCard({ label, value, sub, accent }) {
  return (
    <div className={`stat-card${accent ? ' stat-card--accent' : ''}`}>
      <span className="stat-card__value">{value ?? '—'}</span>
      <span className="stat-card__label">{label}</span>
      {sub && <span className="stat-card__sub">{sub}</span>}
    </div>
  )
}

export default StatCard
