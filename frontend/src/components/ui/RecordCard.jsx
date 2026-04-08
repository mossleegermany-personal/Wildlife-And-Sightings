import '../../css/components/RecordCard.css'

function RecordCard({ title, subtitle, badge, badgeColor = 'default', category, fields = [] }) {
  const cardClass = [
    'record-card',
    category ? `record-card--cat-${category}` : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={cardClass}>
      {/* Header */}
      <div className="record-card__header">
        <span className="record-card__title">{title || '—'}</span>
        {badge && (
          <span className={`record-card__badge record-card__badge--${badgeColor}`}>
            {badge}
          </span>
        )}
      </div>

      {/* Body */}
      {fields.length > 0 && (
        <dl className="record-card__body">
          {fields.map(({ label, value, href }) =>
            value ? (
              <div key={label} className="record-card__field">
                <dt>{label}</dt>
                <dd>
                  {href
                    ? <a href={href} target="_blank" rel="noopener noreferrer" className="record-card__link">{value}</a>
                    : value}
                </dd>
              </div>
            ) : null
          )}
        </dl>
      )}

      {/* Footer */}
      {subtitle && (
        <div className="record-card__footer">
          <span className="record-card__subtitle">{subtitle}</span>
        </div>
      )}
    </div>
  )
}

export default RecordCard
