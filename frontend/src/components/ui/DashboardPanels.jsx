import StatCard from './StatCard'

// ── Stat computation ──────────────────────────────────────────────────────────

export function countBy(rows, colIndex) {
  const map = {}
  rows.forEach((r) => {
    const key = String(r[colIndex] || 'Unknown').trim() || 'Unknown'
    map[key] = (map[key] || 0) + 1
  })
  return Object.entries(map).sort((a, b) => b[1] - a[1])
}

export function bucketByDate(rows, colIndex) {
  const map = {}
  rows.forEach((r) => {
    const raw = String(r[colIndex] || '').replace(/^'/, '').trim()
    if (!raw) return
    let month
    if (/^\d{4}-\d{2}/.test(raw)) month = raw.slice(0, 7)
    else if (/^\d{2}\/\d{2}\/\d{4}/.test(raw)) {
      const [, m, y] = raw.split('/')
      month = `${y}-${m}`
    } else return
    map[month] = (map[month] || 0) + 1
  })
  return Object.entries(map).sort((a, b) => a[0].localeCompare(b[0]))
}

export function computeDashboard(tabId, dataRows) {
  switch (tabId) {
    case 'telegram': {
      const total = dataRows.length
      const byType = countBy(dataRows, 1)
      const byChannel = countBy(dataRows.filter(r => r[6]), 6).slice(0, 10)
      const uniqueUsers = new Set(dataRows.map(r => r[4] || r[3]).filter(Boolean)).size
      const activity = bucketByDate(dataRows, 0)
      return { total, uniqueUsers, byType, byChannel, activity }
    }
    case 'sessions': {
      const total = dataRows.length
      const active = dataRows.filter(r => String(r[13] || '').toLowerCase() === 'active').length
      const ended = dataRows.filter(r => String(r[13] || '').toLowerCase() === 'ended').length
      const avgDuration = (() => {
        let sum = 0, n = 0
        dataRows.forEach(r => {
          const s = r[9], e = r[11]
          if (!s || !e) return
          const parse = (d, t) => {
            const ds = String(d).replace(/^'/, '').trim()
            const ts = String(t || '00:00').replace(/^'/, '').trim()
            return new Date(`${ds}T${ts}`)
          }
          const start = parse(s, r[10]), end = parse(e, r[12])
          const mins = (end - start) / 60000
          if (mins > 0 && mins < 1440) { sum += mins; n++ }
        })
        return n ? Math.round(sum / n) : null
      })()
      const byBot = countBy(dataRows, 1)
      const byChannel = countBy(dataRows.filter(r => r[7]), 7).slice(0, 10)
      const activity = bucketByDate(dataRows, 9)
      return { total, active, ended, avgDuration, byBot, byChannel, activity }
    }
    case 'animal-identification': {
      const total = dataRows.length
      const uniqueSpecies = new Set(dataRows.map(r => r[14]).filter(Boolean)).size
      const uniqueUsers = new Set(dataRows.map(r => r[6] || r[4]).filter(Boolean)).size
      const topSpecies = countBy(dataRows.filter(r => r[14]), 14).slice(0, 10)
      const byCountry = countBy(dataRows.filter(r => r[13]), 13).slice(0, 10)
      const byConfidence = (() => {
        const map = { High: 0, Medium: 0, Low: 0, Unknown: 0 }
        dataRows.forEach(r => {
          const c = String(r[15] || '').toLowerCase()
          if (c.includes('high')) map.High++
          else if (c.includes('med')) map.Medium++
          else if (c.includes('low')) map.Low++
          else map.Unknown++
        })
        return Object.entries(map).filter(([, v]) => v > 0)
      })()
      const activity = bucketByDate(dataRows, 10)
      return { total, uniqueSpecies, uniqueUsers, topSpecies, byCountry, byConfidence, activity }
    }
    case 'bird-sightings': {
      const total = dataRows.length
      const sightings = dataRows.filter(r => r[11] === '/addsighting').length
      const uniqueSpecies = new Set(dataRows.map(r => r[18]).filter(Boolean)).size
      const uniqueLocations = new Set(dataRows.map(r => r[13]).filter(Boolean)).size
      const uniqueUsers = new Set(dataRows.map(r => r[7] || r[6]).filter(Boolean)).size
      const topSpecies = countBy(dataRows.filter(r => r[18]), 18).slice(0, 10)
      const byObsType = countBy(dataRows.filter(r => r[21]), 21)
      const byLocation = countBy(dataRows.filter(r => r[13]), 13).slice(0, 8)
      const activity = bucketByDate(dataRows, 1)
      return { total, sightings, uniqueSpecies, uniqueLocations, uniqueUsers, topSpecies, byObsType, byLocation, activity }
    }
    default:
      return { total: dataRows.length }
  }
}

// ── Dashboard UI primitives ───────────────────────────────────────────────────

function BarList({ entries, total, limit = 10 }) {
  if (!entries.length) return <p className="db-empty">No data</p>
  const top = entries.slice(0, limit)
  const max = top[0]?.[1] || 1
  return (
    <div className="db-barlist">
      {top.map(([label, count]) => {
        const pct = Math.round((count / total) * 100)
        const barW = Math.round((count / max) * 100)
        return (
          <div key={label} className="db-barlist__row">
            <span className="db-barlist__label" title={label}>{label}</span>
            <div className="db-barlist__track">
              <div className="db-barlist__fill" style={{ width: `${barW}%` }} />
            </div>
            <span className="db-barlist__count">{count}</span>
            <span className="db-barlist__pct">{pct}%</span>
          </div>
        )
      })}
    </div>
  )
}

function ActivityChart({ entries }) {
  if (!entries.length) return <p className="db-empty">No data</p>
  const max = Math.max(...entries.map(([, v]) => v), 1)
  return (
    <div className="db-activity">
      {entries.map(([month, count]) => {
        const h = Math.max(4, Math.round((count / max) * 64))
        return (
          <div key={month} className="db-activity__col" title={`${month}: ${count}`}>
            <span className="db-activity__val">{count}</span>
            <div className="db-activity__bar" style={{ height: `${h}px` }} />
            <span className="db-activity__label">{month.slice(5)}</span>
          </div>
        )
      })}
    </div>
  )
}

function DashSection({ title, children, wide }) {
  return (
    <div className={`db-section${wide ? ' db-section--wide' : ''}`}>
      <p className="db-section__title">{title}</p>
      {children}
    </div>
  )
}

// ── Dashboard panels ──────────────────────────────────────────────────────────

export function TelegramDashboard({ data }) {
  return (
    <div className="dashboard">
      <div className="db-stat-row">
        <StatCard label="Total Chats" value={data.total} accent />
        <StatCard label="Unique Users" value={data.uniqueUsers} />
        <StatCard label="Chat Types" value={data.byType.length} />
      </div>
      <div className="db-grid">
        <DashSection title="By Chat Type">
          <BarList entries={data.byType} total={data.total} />
        </DashSection>
        <DashSection title="Top Channels">
          <BarList entries={data.byChannel} total={data.total} />
        </DashSection>
        <DashSection title="Activity by Month" wide>
          <ActivityChart entries={data.activity} />
        </DashSection>
      </div>
    </div>
  )
}

export function SessionsDashboard({ data }) {
  const activeRate = data.total ? Math.round((data.active / data.total) * 100) : 0
  return (
    <div className="dashboard">
      <div className="db-stat-row">
        <StatCard label="Total Sessions" value={data.total} accent />
        <StatCard label="Active" value={data.active} sub={`${activeRate}% of total`} />
        <StatCard label="Ended" value={data.ended} />
        {data.avgDuration != null && <StatCard label="Avg Duration" value={`${data.avgDuration}m`} />}
      </div>
      <div className="db-grid">
        <DashSection title="By Sub-bot">
          <BarList entries={data.byBot} total={data.total} />
        </DashSection>
        <DashSection title="Top Channels">
          <BarList entries={data.byChannel} total={data.total} />
        </DashSection>
        <DashSection title="Sessions by Month" wide>
          <ActivityChart entries={data.activity} />
        </DashSection>
      </div>
    </div>
  )
}

export function AnimalIdDashboard({ data }) {
  return (
    <div className="dashboard">
      <div className="db-stat-row">
        <StatCard label="Total IDs" value={data.total} accent />
        <StatCard label="Unique Species" value={data.uniqueSpecies} />
        <StatCard label="Unique Users" value={data.uniqueUsers} />
      </div>
      <div className="db-grid">
        <DashSection title="Top Species Identified">
          <BarList entries={data.topSpecies} total={data.total} />
        </DashSection>
        <DashSection title="By Country">
          <BarList entries={data.byCountry} total={data.total} />
        </DashSection>
        {data.byConfidence.length > 0 && (
          <DashSection title="Confidence Levels">
            <BarList entries={data.byConfidence} total={data.total} />
          </DashSection>
        )}
        <DashSection title="Activity by Month" wide>
          <ActivityChart entries={data.activity} />
        </DashSection>
      </div>
    </div>
  )
}

export function BirdSightingsDashboard({ data }) {
  const sightingRate = data.total ? Math.round((data.sightings / data.total) * 100) : 0
  return (
    <div className="dashboard">
      <div className="db-stat-row">
        <StatCard label="Total Records" value={data.total} accent />
        <StatCard label="Sightings Added" value={data.sightings} sub={`${sightingRate}% of records`} />
        <StatCard label="Unique Species" value={data.uniqueSpecies} />
        <StatCard label="Locations" value={data.uniqueLocations} />
        <StatCard label="Unique Users" value={data.uniqueUsers} />
      </div>
      <div className="db-grid">
        <DashSection title="Top Species">
          <BarList entries={data.topSpecies} total={data.total} />
        </DashSection>
        <DashSection title="By Observation Type">
          <BarList entries={data.byObsType} total={data.total} />
        </DashSection>
        <DashSection title="Top Locations">
          <BarList entries={data.byLocation} total={data.total} />
        </DashSection>
        <DashSection title="Sightings by Month" wide>
          <ActivityChart entries={data.activity} />
        </DashSection>
      </div>
    </div>
  )
}

export const DASHBOARD_PANELS = {
  telegram: TelegramDashboard,
  sessions: SessionsDashboard,
  'animal-identification': AnimalIdDashboard,
  'bird-sightings': BirdSightingsDashboard,
}
