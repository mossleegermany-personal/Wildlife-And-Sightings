import { useState, useRef } from 'react'
import '../../css/components/IdentifyAnimal.css'

const ACCEPT = 'image/jpeg,image/png,image/webp,image/gif'

const IUCN_META = {
  LC: { label: 'Least Concern',         color: '#4caf50' },
  NT: { label: 'Near Threatened',       color: '#8bc34a' },
  VU: { label: 'Vulnerable',            color: '#ff9800' },
  EN: { label: 'Endangered',            color: '#f44336' },
  CR: { label: 'Critically Endangered', color: '#b71c1c' },
  EW: { label: 'Extinct in the Wild',   color: '#7b1fa2' },
  EX: { label: 'Extinct',               color: '#212121' },
  DD: { label: 'Data Deficient',        color: '#9e9e9e' },
  NE: { label: 'Not Evaluated',         color: '#bdbdbd' },
}

function IucnPill({ code }) {
  const meta = IUCN_META[code] || IUCN_META.NE
  return (
    <span className={`id-pill id-pill--iucn-${code.toLowerCase()}`}>{meta.label}</span>
  )
}

function TaxonomyRow({ label, value }) {
  if (!value || value === 'null') return null
  return (
    <div className="id-tax-row">
      <span className="id-tax-label">{label}</span>
      <span className="id-tax-value">{value}</span>
    </div>
  )
}

/* ── Vertical result card ── */
function ResultCard({ group, onReset }) {
  const [taxOpen,          setTaxOpen]          = useState(false)
  const [ruledOpen,        setRuledOpen]        = useState(false)
  const [reasonOpen,       setReasonOpen]       = useState(true)
  const [sceneOpen,        setSceneOpen]        = useState(true)
  const [sexDimOpen,       setSexDimOpen]       = useState(true)
  const [activePreview,    setActivePreview]    = useState(null)
  const [sightingsOpen,    setSightingsOpen]    = useState(false)
  const [sightingsList,    setSightingsList]    = useState(null)
  const [sightingsLoading, setSightingsLoading] = useState(false)
  const { bestResult: result, items, confirmed } = group

  // Unidentified card
  if (group.failed) {
    return (
      <div className="id-card id-card--failed">
        <div className="id-card__photo">
          <img src={items[0].preview} alt="Unidentified" />
        </div>
        <div className="id-card__body">
          <h2 className="id-card__common id-card__common--unid">Could Not Identify</h2>
          <p className="id-card__prose" style={{ marginTop: 0 }}>{group.reason}</p>
          {items[0].location && (
            <p className="id-card__location">📍 {items[0].location}</p>
          )}
          {onReset && (
            <div className="id-card__actions">
              <button className="id-btn id-btn--secondary" onClick={onReset}>Identify More Photos</button>
            </div>
          )}
        </div>
      </div>
    )
  }

  const tax  = result.taxonomy || {}
  const iucn = result.iucnStatus?.global

  const mainPreview = confirmed
    ? items.reduce((a, b) => ((b.result?.confidence ?? 0) > (a.result?.confidence ?? 0) ? b : a)).preview
    : items[0].preview

  // Collect distinct locations across photos in this group
  const locations = [...new Set(items.map(i => i.location).filter(Boolean))]

  return (
    <div className="id-card">
      {/* Photo — reference species photo (eBird/iNat/Wiki) left, user photo right */}
      <div className="id-card__photo-row">
        {result.referencePhoto?.url ? (
          <div className="id-card__ref-photo">
            <img src={result.referencePhoto.url} alt={result.commonName || 'Reference'} />
            <div className="id-card__caption">RESULT</div>
          </div>
        ) : null}
        <div className={`id-card__user-photo${result.referencePhoto?.url ? ' id-card__user-photo--small' : ''}`}>
          <img src={activePreview ?? mainPreview} alt={result.commonName || 'Animal'} />
          <div className="id-card__photo-strip">
            <span className="id-card__strip-label">INPUT</span>
            {confirmed && items.map((item, i) => (
              <div
                key={i}
                className={`id-card__strip-thumb${(activePreview ?? mainPreview) === item.preview ? ' id-card__strip-thumb--active' : ''}`}
                onClick={() => setActivePreview(item.preview)}
              >
                <img src={item.preview} alt={`Photo ${i + 1}`} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="id-card__body">
        {/* Badges — mirrors Telegram canvas order: Local Status · IUCN · Sex/Stage · Links */}
        <div className="id-card__badges">
          {result.localStatus && (
            <span className="id-pill id-pill--local">
              {result.localStatusCode ? `${result.localStatusCode} · ` : ''}{result.localStatus}
            </span>
          )}
          {result.iucnStatus?.local && !result.localStatus && (
            <span className="id-pill">{result.iucnStatus.local}</span>
          )}
          {iucn && <IucnPill code={iucn} />}
          {result.migratoryStatus && result.migratoryStatus !== 'Unknown' && (
            <span className="id-pill">{result.migratoryStatus}</span>
          )}
          {confirmed && (
            <span className="id-pill id-pill--confirmed">✓ {items.length} photos confirm</span>
          )}
          {result.ebirdVerified && (
            <a className="id-pill id-pill--ebird" href={result.ebirdUrl} target="_blank" rel="noreferrer">
              eBird ↗
            </a>
          )}
          {result.gbifVerified && result.gbifUrl && (
            <a className="id-pill id-pill--gbif" href={result.gbifUrl} target="_blank" rel="noreferrer">
              GBIF ↗
            </a>
          )}
          {result.locationWarning && (
            <span className="id-pill id-pill--warn" title="GBIF found no occurrence records for this species near the given location — the ID may be incorrect">
              ⚠ Not recorded at location
            </span>
          )}
          {result.originalGeminiName && (
            <span className="id-pill id-pill--corrected" title={`AI named: ${result.originalGeminiName}`}>
              ✓ Name corrected
            </span>
          )}
          {result.ebirdUpdatedName && !result.originalGeminiName && (
            <span className="id-pill id-pill--corrected" title={`eBird taxonomy: ${result.ebirdUpdatedName}`}>
              eBird updated
            </span>
          )}
          {/* Sex badge */}
          {result.displaySex && (() => {
            const isMale = result.displaySex.toLowerCase() === 'male';
            return (
              <span className={`id-pill ${isMale ? 'id-pill--male' : 'id-pill--female'}`}>
                {isMale ? '♂' : '♀'} {result.displaySex}
              </span>
            );
          })()}
          {/* Life Stage badge */}
          {result.lifeStage && result.lifeStage !== 'Unknown' && (
            <span className="id-pill id-pill--stage">{result.lifeStage}</span>
          )}
          {/* Breeding Plumage badge */}
          {result.breedingPlumage === 'Yes' && (
            <span className="id-pill id-pill--breeding">Breeding Plumage</span>
          )}
          {/* Morph badge */}
          {result.morph && result.morph !== 'null' && result.morph !== 'Unknown' && (
            <span className="id-pill id-pill--morph">{result.morph} morph</span>
          )}
        </div>

        {/* Names */}
        <h2 className="id-card__common">{result.commonName || 'Unknown Animal'}</h2>
        <p className="id-card__scientific">{result.scientificName}</p>

        {/* Location(s) */}
        {locations.length > 0 && (
          <p className="id-card__location">
            📍 {locations.join(' · ')}
          </p>
        )}

        {/* Subspecies */}
        {result.displaySubspecies && (
          <div className="id-card__subspecies">
            <p className="id-card__sub-label">{result.displaySubspeciesLabel}</p>
            {Array.isArray(result.displaySubspecies)
              ? result.displaySubspecies.map((e, i) => (
                  <p key={i} className="id-card__sub-value">- {e}</p>
                ))
              : <p className="id-card__sub-image-name">{result.displaySubspecies}</p>
            }
          </div>
        )}

        {/* Sightings count + live sightings list */}
        {result.ebirdCode && result.ebirdSightingsRegionCode && (
          <div className="id-card__sightings">
            <p className="id-card__sightings-label">
              No. of Sightings ({locations.length > 0 ? locations[0] : result.ebirdSightingsLocation || 'Location'}):
            </p>
            {result.ebirdSightingsCount != null && (
              <span className="id-card__sightings-count">{result.ebirdSightingsCount}</span>
            )}
            <button
              className="id-btn--sightings"
              onClick={async () => {
                if (sightingsLoading) return
                setSightingsLoading(true)
                try {
                  const res = await fetch('/api/v1/sightings/species', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ regionCode: result.ebirdSightingsRegionCode, speciesCode: result.ebirdCode, back: 30 }),
                  })
                  const data = await res.json()
                  setSightingsList(data.observations || [])
                } catch {
                  setSightingsList([])
                }
                setSightingsLoading(false)
              }}
              disabled={sightingsLoading}
            >
              {sightingsLoading ? 'Loading…' : '🔍 Sightings'}
            </button>
            {sightingsList !== null && (
              <div className="id-sightings-list">
                {sightingsList.length === 0 ? (
                  <p className="id-sightings-empty">No recent sightings found.</p>
                ) : (
                  sightingsList.map((obs, i) => {
                    const [datePart, timePart] = (obs.obsDt || '').split(' ')
                    const fmtDate = datePart ? datePart.split('-').reverse().join('/') : null
                    const cnt = obs.howMany ? `${obs.howMany} bird${obs.howMany > 1 ? 's' : ''}` : 'Present'
                    const locUrl = obs.locId ? `https://ebird.org/hotspot/${obs.locId}` : null
                    const mapsUrl = (obs.lat != null && obs.lng != null)
                      ? `https://www.google.com/maps?q=${obs.lat},${obs.lng}` : null
                    const coordLabel = (obs.lat != null && obs.lng != null)
                      ? `${Number(obs.lat).toFixed(4)}, ${Number(obs.lng).toFixed(4)}` : null
                    return (
                      <div key={i} className="id-sightings-entry">
                        <div className="id-sightings-entry__name">
                          {i + 1}. {obs.comName || obs.sciName || '—'}
                        </div>
                        <div className="id-sightings-entry__row">
                          <span className="id-sightings-entry__icon">📍</span>
                          <span className="id-sightings-entry__label">Location:</span>
                          {locUrl
                            ? <a className="id-sightings-entry__link" href={locUrl} target="_blank" rel="noreferrer">{obs.locName || '—'}</a>
                            : <span className="id-sightings-entry__val">{obs.locName || '—'}</span>
                          }
                        </div>
                        <div className="id-sightings-entry__row">
                          <span className="id-sightings-entry__icon">🔍</span>
                          <span className="id-sightings-entry__label">Count:</span>
                          <span className="id-sightings-entry__val id-sightings-entry__val--bold">{cnt}</span>
                        </div>
                        <div className="id-sightings-entry__row">
                          <span className="id-sightings-entry__icon">🔬</span>
                          <span className="id-sightings-entry__label">Age/Sex:</span>
                          <span className="id-sightings-entry__val">{obs.ageSex || '—'}</span>
                        </div>
                        {fmtDate && (
                          <div className="id-sightings-entry__row">
                            <span className="id-sightings-entry__icon">📅</span>
                            <span className="id-sightings-entry__label">Date:</span>
                            <span className="id-sightings-entry__val">{fmtDate}</span>
                          </div>
                        )}
                        {timePart && (
                          <div className="id-sightings-entry__row">
                            <span className="id-sightings-entry__icon">🕒</span>
                            <span className="id-sightings-entry__label">Time:</span>
                            <span className="id-sightings-entry__val">{timePart} hrs</span>
                          </div>
                        )}
                        {obs.subId && (
                          <div className="id-sightings-entry__row">
                            <span className="id-sightings-entry__icon">🔗</span>
                            <span className="id-sightings-entry__label">Checklist:</span>
                            <a className="id-sightings-entry__link" href={`https://ebird.org/checklist/${obs.subId}`} target="_blank" rel="noreferrer">View</a>
                          </div>
                        )}
                        {coordLabel && mapsUrl && (
                          <div className="id-sightings-entry__row">
                            <span className="id-sightings-entry__icon">🗺️</span>
                            <span className="id-sightings-entry__label">Coords:</span>
                            <a className="id-sightings-entry__link" href={mapsUrl} target="_blank" rel="noreferrer">{coordLabel}</a>
                          </div>
                        )}
                        {obs.userDisplayName && (
                          <div className="id-sightings-entry__row">
                            <span className="id-sightings-entry__icon">👤</span>
                            <span className="id-sightings-entry__label">Observer:</span>
                            <span className="id-sightings-entry__val">{obs.userDisplayName}</span>
                          </div>
                        )}
                        {obs.breedingCode && (
                          <div className="id-sightings-entry__row">
                            <span className="id-sightings-entry__icon">🐣</span>
                            <span className="id-sightings-entry__label">Breeding:</span>
                            <span className="id-sightings-entry__val">{obs.breedingCode}</span>
                          </div>
                        )}
                        {obs.comments && (
                          <div className="id-sightings-entry__row">
                            <span className="id-sightings-entry__icon">💬</span>
                            <span className="id-sightings-entry__label">Notes:</span>
                            <span className="id-sightings-entry__val">{obs.comments}</span>
                          </div>
                        )}
                        {obs.mlMedia?.photos?.length > 0 && (
                          <div className="id-sightings-entry__row">
                            <span className="id-sightings-entry__icon">📷</span>
                            <span className="id-sightings-entry__label">Photo:</span>
                            {obs.mlMedia.photos.slice(0, 3).map((url, pi) => (
                              <a key={pi} className="id-sightings-entry__media-link" href={url} target="_blank" rel="noreferrer">Photo{obs.mlMedia.photos.length > 1 ? ` ${pi + 1}` : ''}</a>
                            ))}
                          </div>
                        )}
                        {obs.mlMedia?.audios?.length > 0 && (
                          <div className="id-sightings-entry__row">
                            <span className="id-sightings-entry__icon">🔊</span>
                            <span className="id-sightings-entry__label">Audio:</span>
                            {obs.mlMedia.audios.slice(0, 3).map((url, ai) => (
                              <a key={ai} className="id-sightings-entry__media-link" href={url} target="_blank" rel="noreferrer">Audio{obs.mlMedia.audios.length > 1 ? ` ${ai + 1}` : ''}</a>
                            ))}
                          </div>
                        )}
                        {obs.mlMedia?.videos?.length > 0 && (
                          <div className="id-sightings-entry__row">
                            <span className="id-sightings-entry__icon">🎥</span>
                            <span className="id-sightings-entry__label">Video:</span>
                            {obs.mlMedia.videos.slice(0, 3).map((url, vi) => (
                              <a key={vi} className="id-sightings-entry__media-link" href={url} target="_blank" rel="noreferrer">Video{obs.mlMedia.videos.length > 1 ? ` ${vi + 1}` : ''}</a>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            )}
          </div>
        )}

        {/* Collapsible: Scene */}
        {result.sceneDescription && (
          <div className="id-card__section">
            <button className="id-collapsible" onClick={() => setSceneOpen(o => !o)}>
              Scene <span>{sceneOpen ? '▾' : '▸'}</span>
            </button>
            {sceneOpen && <p className="id-card__prose">{result.sceneDescription}</p>}
          </div>
        )}

        {/* Collapsible: Reasoning */}
        {result.identificationReasoning && (
          <div className="id-card__section">
            <button className="id-collapsible" onClick={() => setReasonOpen(o => !o)}>
              Identification Reasoning <span>{reasonOpen ? '▾' : '▸'}</span>
            </button>
            {reasonOpen && <p className="id-card__prose">{result.identificationReasoning}</p>}
          </div>
        )}

        {/* Collapsible: Sexual dimorphism + plumage */}
        {(result.sexualDimorphism || result.plumageNotes) && (
          <div className="id-card__section">
            <button className="id-collapsible" onClick={() => setSexDimOpen(o => !o)}>
              Plumage &amp; Sexual Dimorphism <span>{sexDimOpen ? '▾' : '▸'}</span>
            </button>
            {sexDimOpen && (
              <div>
                {result.plumageNotes && (
                  <p className="id-card__prose">{result.plumageNotes}</p>
                )}
                {result.sexualDimorphism && (
                  <>
                    <p className="id-card__prose-sub">Species dimorphism:</p>
                    <p className="id-card__prose" style={{ color: '#8a8a8a' }}>{result.sexualDimorphism}</p>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Collapsible: Taxonomy */}
        {Object.values(tax).some(v => v && v !== 'null') && (
          <div className="id-card__section">
            <button className="id-collapsible" onClick={() => setTaxOpen(o => !o)}>
              Taxonomy <span>{taxOpen ? '▾' : '▸'}</span>
            </button>
            {taxOpen && (
              <div className="id-tax">
                <TaxonomyRow label="Kingdom"    value={tax.kingdom} />
                <TaxonomyRow label="Phylum"     value={tax.phylum} />
                <TaxonomyRow label="Class"      value={tax.class} />
                <TaxonomyRow label="Order"      value={tax.order} />
                <TaxonomyRow label="Family"     value={tax.family} />
                <TaxonomyRow label="Subfamily"  value={tax.subfamily} />
                <TaxonomyRow label="Genus"      value={tax.genus} />
                <TaxonomyRow label="Species"    value={tax.species} />
                <TaxonomyRow label="Subspecies" value={tax.subspecies} />
              </div>
            )}
          </div>
        )}

        {/* Collapsible: Similar species */}
        {result.similarSpeciesRuledOut?.length > 0 && (
          <div className="id-card__section">
            <button className="id-collapsible" onClick={() => setRuledOpen(o => !o)}>
              Similar Species Ruled Out <span>{ruledOpen ? '▾' : '▸'}</span>
            </button>
            {ruledOpen && (
              <ul className="id-ruled-list">
                {result.similarSpeciesRuledOut.map((s, i) => (
                  <li key={i} className="id-ruled-item">{s}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Reset button on last card */}
        {onReset && (
          <div className="id-card__actions">
            <button className="id-btn id-btn--secondary" onClick={onReset}>
              Identify More Photos
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default function IdentifyAnimal() {
  // files: [{id, file, preview, location}]
  const [files, setFiles] = useState([])
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [bulkLoc, setBulkLoc] = useState('')
  const [status, setStatus] = useState('idle')     // idle | ready | loading | success
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [groupedResults, setGroupedResults] = useState([])
  const [error, setError] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [completedIds, setCompletedIds] = useState(new Set())
  const [activeGroup, setActiveGroup] = useState(null)
  const inputRef = useRef()

  function addFiles(rawFiles) {
    const list = Array.from(rawFiles)
    const valid = list.filter(f => f.type.startsWith('image/'))
    const skipped = list.length - valid.length
    if (skipped > 0) setError(`${skipped} file${skipped > 1 ? 's' : ''} skipped — must be an image (JPEG, PNG, WebP or GIF).`)
    else setError(null)
    const toAdd = valid.map(f => ({
      id: Math.random().toString(36).slice(2),
      file: f,
      preview: URL.createObjectURL(f),
      location: '',
    }))
    if (!toAdd.length) return
    setFiles(prev => [...prev, ...toAdd])
    setStatus('ready')
  }

  function removeFile(id) {
    setFiles(prev => {
      const removed = prev.find(f => f.id === id)
      if (removed) URL.revokeObjectURL(removed.preview)
      const next = prev.filter(f => f.id !== id)
      if (next.length === 0) setStatus('idle')
      return next
    })
    setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  function updateLocation(id, value) {
    setFiles(prev => prev.map(f => f.id === id ? { ...f, location: value } : f))
  }

  function toggleSelect(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectAll() {
    if (selectedIds.size === files.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(files.map(f => f.id)))
    }
  }

  function applyBulkLoc() {
    if (!bulkLoc.trim()) return
    setFiles(prev => prev.map(f => selectedIds.has(f.id) ? { ...f, location: bulkLoc.trim() } : f))
    setBulkLoc('')
    setSelectedIds(new Set())
  }

  function clearSelectedLoc() {
    setFiles(prev => prev.map(f => selectedIds.has(f.id) ? { ...f, location: '' } : f))
    setSelectedIds(new Set())
  }

  function handleDrop(e) {
    e.preventDefault()
    setDragging(false)
    addFiles(e.dataTransfer.files)
  }

  async function handleSubmit() {
    if (!files.length) return
    setStatus('loading')
    setError(null)
    setProgress({ done: 0, total: files.length })

    setCompletedIds(new Set())

    const settled = await Promise.allSettled(
      files.map(({ id, file, preview, location }) =>
        (async () => {
          const fd = new FormData()
          fd.append('image', file)
          if (location.trim()) fd.append('location', location.trim())
          const res = await fetch('/api/v1/identify', { method: 'POST', body: fd })
          const json = await res.json()
          if (!res.ok || !json.success) return { preview, location, failed: true, reason: json.error || `Server error ${res.status}` }
          if (!json.data?.identified) return { preview, location, failed: true, reason: json.data?.qualityIssue || 'No animal detected in this photo.' }
          return { preview, location, result: json.data }
        })().finally(() => {
          setProgress(p => ({ ...p, done: p.done + 1 }))
          setCompletedIds(prev => new Set([...prev, id]))
        })
      )
    )

    const allItems = settled.filter(r => r.status === 'fulfilled').map(r => r.value)
    const successful = allItems.filter(i => !i.failed)
    const failedItems = allItems.filter(i => i.failed)

    if (!allItems.length) {
      setError('Something went wrong. Please try again.')
      setStatus('ready')
      return
    }

    // Group by species; multiple photos of same species → confirmed
    const groupMap = new Map()
    for (const item of successful) {
      const key = (item.result.scientificName || item.result.commonName || 'unknown').toLowerCase().trim()
      if (!groupMap.has(key)) groupMap.set(key, [])
      groupMap.get(key).push(item)
    }

    const groups = Array.from(groupMap.values()).map(items => {
      const best = items.reduce((a, b) => (b.result.confidence > a.result.confidence ? b : a))
      return { items, bestResult: best.result, confirmed: items.length > 1 }
    })

    for (const item of failedItems) {
      groups.push({ items: [item], bestResult: null, failed: true, reason: item.reason })
    }

    setGroupedResults(groups)
    setStatus('success')
  }

  function handleReset() {
    files.forEach(f => URL.revokeObjectURL(f.preview))
    setFiles([])
    setGroupedResults([])
    setError(null)
    setStatus('idle')
    setProgress({ done: 0, total: 0 })
    setSelectedIds(new Set())
    setBulkLoc('')
    setCompletedIds(new Set())
    setActiveGroup(null)
  }

  // ── Success view ──
  if (status === 'success' && groupedResults.length > 0) {
    return (
      <div className="id-view id-view--results">
        {/* Results header */}
        <div className="id-results-header">
          <p className="id-batch-header">
            Found <strong>{groupedResults.filter(g => !g.failed).length} species</strong> across {files.length} photo{files.length !== 1 ? 's' : ''}
          </p>
          <button className="id-add-btn" onClick={handleReset}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            New Identification
          </button>
        </div>

        {/* Thumbnail grid */}
        <div className="id-result-grid">
          {groupedResults.map((group, i) => {
            const result = group.bestResult
            const preview = group.failed
              ? group.items[0].preview
              : (group.confirmed
                ? group.items.reduce((a, b) => ((b.result?.confidence ?? 0) > (a.result?.confidence ?? 0) ? b : a)).preview
                : group.items[0].preview)
            const iucn = result?.iucnStatus?.global
            const conf = result?.confidence
            return (
              <div
                key={i}
                className={`id-result-thumb${group.failed ? ' id-result-thumb--failed' : ''}${group.confirmed ? ' id-result-thumb--confirmed' : ''}`}
                onClick={() => setActiveGroup(i)}
              >
                <div className="id-result-thumb__img">
                  <img src={preview} alt={result?.commonName || 'Unidentified'} />
                  {group.confirmed && (
                    <span className="id-result-thumb__badge">{group.items.length} photos</span>
                  )}
                  {group.failed && (
                    <span className="id-result-thumb__fail">✗</span>
                  )}
                </div>
                <div className="id-result-thumb__info">
                  <span className="id-result-thumb__name">
                    {group.failed ? 'Could Not Identify' : (result?.commonName || 'Unknown')}
                  </span>
                  <div className="id-result-thumb__meta">
                    {!group.failed && iucn && <IucnPill code={iucn} />}
                    {!group.failed && conf != null && (
                      <span className="id-result-thumb__conf">{Math.round(conf * 100)}%</span>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>

        {/* Detail modal */}
        {activeGroup !== null && (
          <div className="id-detail-overlay" onClick={() => setActiveGroup(null)}>
            <div className="id-detail-modal" onClick={e => e.stopPropagation()}>
              <div className="id-detail-modal__header">
                <span className="id-detail-modal__title">{activeGroup + 1} / {groupedResults.length}</span>
                <div className="id-detail-nav">
                  <button
                    className="id-detail-nav-btn"
                    onClick={() => setActiveGroup(i => Math.max(0, i - 1))}
                    disabled={activeGroup === 0}
                  >‹</button>
                  <button
                    className="id-detail-nav-btn"
                    onClick={() => setActiveGroup(i => Math.min(groupedResults.length - 1, i + 1))}
                    disabled={activeGroup === groupedResults.length - 1}
                  >›</button>
                  <button className="id-detail-close-btn" onClick={() => setActiveGroup(null)}>✕</button>
                </div>
              </div>
              <div className="id-detail-modal__body">
                <ResultCard group={groupedResults[activeGroup]} onReset={null} />
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── Upload view ──
  return (
    <div className="id-view">
      {/* ── Toolbar ── */}
      <div className="id-toolbar">
        <div className="id-toolbar__left">
          <button
            className="id-add-btn"
            onClick={() => inputRef.current.click()}
            disabled={status === 'loading'}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            {files.length > 0 ? 'Add More' : 'Add Photos'}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={(e) => addFiles(e.target.files)}
          />
          {files.length > 0 && (
            <label className="id-select-all">
              <input
                type="checkbox"
                checked={selectedIds.size === files.length}
                ref={el => { if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < files.length }}
                onChange={toggleSelectAll}
                disabled={status === 'loading'}
              />
              <span>{selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select all'}</span>
            </label>
          )}
        </div>

        {/* Location assignment (only when photos selected) */}
        {selectedIds.size > 0 && (
          <div className="id-toolbar__loc">
            <input
              className="id-toolbar__loc-input"
              placeholder="Set location for selected…"
              value={bulkLoc}
              onChange={e => setBulkLoc(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && applyBulkLoc()}
              disabled={status === 'loading'}
            />
            <button className="id-toolbar__loc-apply" onClick={applyBulkLoc} disabled={!bulkLoc.trim() || status === 'loading'}>Apply</button>
            <button className="id-toolbar__loc-clear" onClick={clearSelectedLoc} disabled={status === 'loading'}>Clear</button>
          </div>
        )}

        {files.length > 0 && (
          <div className="id-toolbar__right">
            <button
              className="id-identify-btn"
              disabled={status === 'loading'}
              onClick={handleSubmit}
            >
              {status === 'loading'
                ? <><span className="id-spinner id-spinner--dark" /> {progress.done} / {progress.total}</>
                : `Identify${files.length > 1 ? ` ${files.length} Photos` : ''}`
              }
            </button>
          </div>
        )}
      </div>

      {error && <p className="id-error id-error--toolbar">{error}</p>}

      {/* ── Empty drop zone ── */}
      {files.length === 0 && (
        <div
          className={`id-dropzone id-dropzone--full${dragging ? ' id-dropzone--drag' : ''}`}
          onClick={() => inputRef.current.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === 'Enter' && inputRef.current.click()}
        >
          <div className="id-dropzone__hint">
            <svg className="id-dropzone__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            <span className="id-dropzone__main">Drop photos here or <strong>browse</strong></span>
            <span className="id-dropzone__formats">JPEG · PNG · WebP · GIF</span>
          </div>
        </div>
      )}

      {/* ── Progress modal ── */}
      {status === 'loading' && (
        <div className="id-prog-overlay">
          <div className="id-prog-modal">
            <p className="id-prog-title">Identifying Photos…</p>
            <p className="id-prog-count">
              <strong>{progress.done}</strong> of <strong>{progress.total}</strong> analyzed
            </p>
            <div className="id-prog-bar">
              <div
                className={`id-prog-bar__fill${progress.done === 0 ? ' id-prog-bar__fill--pulse' : ''}`}
                style={{ width: `${progress.total ? Math.max((progress.done / progress.total) * 100, progress.done === 0 ? 8 : 0) : 8}%` }}
              />
            </div>
            <div className="id-prog-thumbs">
              {files.map(({ id, preview }, i) => (
                <div key={id} className={`id-prog-thumb${completedIds.has(id) ? ' id-prog-thumb--done' : ''}`}>
                  <img src={preview} alt={`Photo ${i + 1}`} />
                  {completedIds.has(id)
                    ? <span className="id-prog-thumb__tick">✓</span>
                    : <span className="id-prog-thumb__spin"><span className="id-spinner" /></span>
                  }
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Photo grid ── */}
      {files.length > 0 && (
        <div
          className="id-photo-grid"
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          {files.map(({ id, preview, location }, i) => (
            <div key={id} className={`id-photo-card${selectedIds.has(id) ? ' id-photo-card--selected' : ''}`}>
              <div className="id-photo-card__img-wrap">
                <img src={preview} alt={`Photo ${i + 1}`} />
                <label className="id-photo-card__check">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(id)}
                    onChange={() => toggleSelect(id)}
                    disabled={status === 'loading'}
                  />
                </label>
                <button
                  className="id-photo-card__remove"
                  onClick={() => removeFile(id)}
                  disabled={status === 'loading'}
                  aria-label="Remove"
                >✕</button>
              </div>
              <div className="id-photo-card__info">
                <span className="id-photo-card__num">Photo {i + 1}</span>
                {location ? (
                  <span className="id-photo-card__loc">
                    📍 {location}
                    <button className="id-photo-card__loc-clear" onClick={() => updateLocation(id, '')} disabled={status === 'loading'}>×</button>
                  </span>
                ) : (
                  <span className="id-photo-card__no-loc">No location</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
