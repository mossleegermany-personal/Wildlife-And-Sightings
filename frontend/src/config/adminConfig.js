export const SPREADSHEET_ID = '1NibfioE1prLYElDXIVxy-6ybPw2-Q9HNicDacfcbrmM'

export const TABS = [
  { id: 'telegram', label: 'Telegram', range: 'Telegram!A1:G5000' },
  { id: 'sessions', label: 'Sessions', range: 'Sessions!A1:N5000' },
  { id: 'animal-identification', label: 'Animal Identification', range: 'Animal Identification!A1:P5000' },
  { id: 'bird-sightings', label: 'Bird Sightings', range: 'Bird Sightings!A1:W5000' },
]

export const VIEWS = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'cards', label: 'Cards' },
  { id: 'table', label: 'Table' },
]

export const CARDS_PER_PAGE = 8

export async function fetchSheet(range) {
  const res = await fetch('/api/v1/sheets/read', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ spreadsheetId: SPREADSHEET_ID, range }),
  })
  if (!res.ok) throw new Error(`Server error: HTTP ${res.status}`)
  const data = await res.json()
  return data.rows ?? []
}

export function getCategoryOptions(tabId, dataRows) {
  switch (tabId) {
    case 'telegram': return [...new Set(dataRows.map(r => String(r[1] || '').trim()).filter(Boolean))]
    case 'sessions': return [...new Set(dataRows.map(r => String(r[13] || '').trim()).filter(Boolean))]
    case 'animal-identification': return [...new Set(dataRows.map(r => String(r[13] || '').trim()).filter(Boolean))]
    case 'bird-sightings': return [...new Set(dataRows.map(r => String(r[11] || '').trim()).filter(Boolean))]
    default: return []
  }
}

// Columns confirmed from backend googleSheetsService.js:
//   Telegram (A:G):       [0]SN [1]ChatType [2]ChatId [3]ChannelId [4]Sender [5]DisplayName [6]ChannelName
//   Sessions (A:N):       [0]SN [1]Bot [2]SessionId [3]Sender [4]DisplayName [5]ChatId [6]ChannelId [7]ChannelName [8]ChatType [9]StartDate [10]StartTime [11]EndDate [12]EndTime [13]Status
//   Animal ID (A:P):      [0]SN [1]ChatId [2]ChannelId [3]SessionId [4]UserName [5]DisplayName [6]ChannelName [7]Sender [8]ChatType [9]Platform [10]Date [11]Time [12]Location [13]Country [14]Species [15]Image
//   Bird Sightings (A:W): [0]SN [1]Date [2]Time [3]ChatId [4]ChannelId [5]SessionId [6]UserName [7]DisplayName [8]ChannelName [9]Sender [10]ChatType [11]Command [12]SearchQuery [13]Location [14]Country [15]TotalSightings [16]Count [17]SpeciesList [18]Species [19]ObsDate [20]Count [21]ObsType [22]Notes
export function getFilterConfigs(tabId) {
  switch (tabId) {
    case 'telegram': return [
      { label: 'Channel', col: 6 },
      { label: 'Sender',  col: 4 },
    ]
    case 'sessions': return [
      { label: 'Bot',       col: 1 },
      { label: 'Chat Type', col: 8 },
      { label: 'Channel',   col: 7 },
    ]
    case 'animal-identification': return [
      { label: 'Chat Type', col: 8  },
      { label: 'Channel',   col: 6  },
      { label: 'Location',  col: 12 },
    ]
    case 'bird-sightings': return [
      { label: 'Chat Type', col: 10 },
      { label: 'Obs Type',  col: 21 },
      { label: 'Country',   col: 14 },
      { label: 'Location',  col: 13 },
    ]
    default: return []
  }
}

export function getRowCategory(tabId, row) {
  switch (tabId) {
    case 'telegram': return String(row[1] || '').trim()
    case 'sessions': return String(row[13] || '').trim()
    case 'animal-identification': return String(row[13] || '').trim()
    case 'bird-sightings': return String(row[11] || '').trim()
    default: return ''
  }
}
