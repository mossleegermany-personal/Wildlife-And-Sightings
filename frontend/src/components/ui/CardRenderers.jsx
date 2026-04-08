import RecordCard from './RecordCard'

const _regionNames = (typeof Intl !== 'undefined' && Intl.DisplayNames)
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null

function resolveRegionLabel(code) {
  if (!code) return undefined
  try { return _regionNames?.of(code.trim().toUpperCase()) || code } catch { return code }
}

export function TelegramCard({ row }) {
  const [, chatType, chatId, , sender, displayName, channelName] = row
  const name = displayName || sender || '—'
  const cat = (chatType || 'other').toLowerCase().replace(/\s+/g, '-')
  return (
    <RecordCard
      title={name}
      subtitle={sender !== name ? sender : undefined}
      badge={chatType}
      badgeColor={chatType?.toLowerCase() === 'private' ? 'blue' : 'green'}
      category={cat}
      fields={[
        { label: 'Chat ID', value: chatId },
        { label: 'Channel', value: channelName },
      ]}
    />
  )
}

export function SessionCard({ row }) {
  const [sn, subbot, sessionId, sender, displayName, , , channelName, , startDate, startTime, endDate, endTime, status] = row
  const name = displayName || sender || '—'
  const statusLower = String(status || '').toLowerCase()
  const statusColor = statusLower === 'active' ? 'green' : statusLower === 'ended' ? 'grey' : 'default'
  return (
    <RecordCard
      title={name}
      subtitle={`#${sn} · ${subbot || 'Unknown bot'}`}
      badge={status || 'unknown'}
      badgeColor={statusColor}
      category={statusLower || 'unknown'}
      fields={[
        { label: 'Session ID', value: sessionId },
        { label: 'Channel', value: channelName },
        { label: 'Start Date', value: startDate || undefined },
        { label: 'Start Time', value: startTime || undefined },
        { label: 'End Date', value: endDate || undefined },
        { label: 'End Time', value: endTime || undefined },
      ]}
    />
  )
}

export function AnimalIdentCard({ row }) {
  const [sn, , , , userName, displayName, channelName, , , , date, time, location, country, species, image] = row
  const name = displayName || userName || '—'
  const cleanDate = date?.replace(/^'/, '') || undefined
  const cleanTime = time?.replace(/^'/, '') || undefined
  const where = [location, country].filter(Boolean).join(', ') || undefined
  const cat = (country || 'unknown').toLowerCase().replace(/\s+/g, '-')
  const imageHref = image ? `https://drive.google.com/file/d/${image}/view` : undefined
  return (
    <RecordCard
      title={species || 'Unknown species'}
      subtitle={`#${sn} · ${name}`}
      category={cat}
      fields={[
        { label: 'Date', value: cleanDate },
        { label: 'Time', value: cleanTime },
        { label: 'Where', value: where },
        { label: 'Channel', value: channelName },
        { label: 'Image ID', value: image, href: imageHref },
      ]}
    />
  )
}

export function BirdSightingCard({ row }) {
  const [sn, date, time, , , , userName, displayName, channelName, , , command, searchQuery, location, country, totalSightings, uniqueCount, , species, obsDate, count, obsType, notes] = row
  const name = displayName || userName || '—'
  const cleanDate = date?.replace(/^'/, '') || undefined
  const cleanTime = time?.replace(/^'/, '') || undefined
  const regionLabel = resolveRegionLabel(country)
  const where = [location, regionLabel].filter(Boolean).join(', ') || undefined
  const title = species || searchQuery || command || '—'
  const cat = (command || 'other').replace(/^\//, '').toLowerCase()
  return (
    <RecordCard
      title={title}
      subtitle={`#${sn} · ${name}`}
      badge={command}
      badgeColor="blue"
      category={cat}
      fields={[
        { label: 'Date', value: cleanDate },
        { label: 'Time', value: cleanTime },
        { label: 'Where', value: where },
        { label: 'Obs Date', value: obsDate },
        { label: 'Count', value: count?.toString() },
        { label: 'Type', value: obsType },
        { label: 'Total Sightings', value: totalSightings?.toString() },
        { label: 'Unique Species', value: uniqueCount?.toString() },
        { label: 'Channel', value: channelName },
        { label: 'Notes', value: notes },
      ]}
    />
  )
}

export const CARD_RENDERERS = {
  telegram: TelegramCard,
  sessions: SessionCard,
  'animal-identification': AnimalIdentCard,
  'bird-sightings': BirdSightingCard,
}
