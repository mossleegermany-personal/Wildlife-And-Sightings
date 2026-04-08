import { useState, useEffect, useCallback, useMemo } from 'react'
import DataTable from '../components/ui/DataTable'
import FilterDropdown from '../components/ui/FilterDropdown'
import { DASHBOARD_PANELS, computeDashboard } from '../components/ui/DashboardPanels'
import { CARD_RENDERERS } from '../components/ui/CardRenderers'
import {
  TABS, VIEWS, CARDS_PER_PAGE,
  fetchSheet,
  getCategoryOptions, getFilterConfigs, getRowCategory,
} from '../config/adminConfig'
import { useSheetSocket } from '../hooks/useSheetSocket'
import '../css/pages/Admin.css'
import '../css/components/StatCard.css'

function Admin() {
  const [activeTab, setActiveTab] = useState(TABS[0].id)
  const [viewMode, setViewMode] = useState('dashboard')
  const [sidebarPinned, setSidebarPinned] = useState(false)
  const [sidebarHovered, setSidebarHovered] = useState(false)
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [search, setSearch] = useState('')
  const [filterCat, setFilterCat] = useState('')
  const [filterValues, setFilterValues] = useState([]) // indexed by filterConfigs position
  const [cardPage, setCardPage] = useState(1)

  const activeRange = TABS.find((t) => t.id === activeTab)?.range

  const load = useCallback(async (tabId) => {
    const tab = TABS.find((t) => t.id === tabId)
    if (!tab) return
    setLoading(true)
    setError(null)
    setRows([])
    setCardPage(1)
    try {
      const data = await fetchSheet(tab.range)
      setRows(data)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleLiveUpdate = useCallback((freshRows) => {
    setRows(freshRows)
  }, [])

  const connected = useSheetSocket(activeRange, handleLiveUpdate)

  useEffect(() => {
    load(activeTab)
    setFilterCat('')
    setFilterValues([])
  }, [activeTab, load])

  const dataRows = rows.slice(1)

  const filterConfigs = useMemo(() => getFilterConfigs(activeTab), [activeTab])
  const searchQ = search.trim().toLowerCase()

  // Each dropdown's options: values present in rows matching filterCat + search + all OTHER dropdowns (faceted)
  const filterOptionsList = useMemo(() => {
    return filterConfigs.map((cfg, i) => {
      const eligible = dataRows.filter(row => {
        if (searchQ && !row.some(cell => String(cell ?? '').toLowerCase().includes(searchQ))) return false
        if (filterCat && getRowCategory(activeTab, row) !== filterCat) return false
        return filterConfigs.every((otherCfg, j) => {
          if (j === i || !filterValues[j]) return true
          return String(row[otherCfg.col] || '').trim() === filterValues[j]
        })
      })
      return [...new Set(eligible.map(r => String(r[cfg.col] || '').trim()).filter(Boolean))]
    })
  }, [dataRows, filterCat, filterValues, filterConfigs, searchQ, activeTab])

  // Category chips: faceted — categories present in rows matching all dropdowns + search
  const categoryOptions = useMemo(() => {
    const eligible = dataRows.filter(row => {
      if (searchQ && !row.some(cell => String(cell ?? '').toLowerCase().includes(searchQ))) return false
      return filterConfigs.every((cfg, i) => !filterValues[i] || String(row[cfg.col] || '').trim() === filterValues[i])
    })
    return getCategoryOptions(activeTab, eligible)
  }, [dataRows, filterValues, filterConfigs, searchQ, activeTab])

  // filtered: actual displayed data — all active constraints applied
  const filtered = useMemo(() => {
    return dataRows.filter(row => {
      if (searchQ && !row.some(cell => String(cell ?? '').toLowerCase().includes(searchQ))) return false
      if (filterCat && getRowCategory(activeTab, row) !== filterCat) return false
      return filterConfigs.every((cfg, i) => !filterValues[i] || String(row[cfg.col] || '').trim() === filterValues[i])
    })
  }, [dataRows, searchQ, filterCat, filterValues, filterConfigs, activeTab])

  // Auto-clear selected values that no longer appear in their available options
  useEffect(() => {
    setFilterValues(prev => {
      const next = [...prev]
      let changed = false
      filterConfigs.forEach((_, i) => {
        const opts = filterOptionsList[i]
        if (next[i] && opts && opts.length > 0 && !opts.includes(next[i])) {
          next[i] = ''
          changed = true
        }
      })
      return changed ? next : prev
    })
  }, [filterOptionsList, filterConfigs])

  // Reset to page 1 when any filter/search/tab changes
  useEffect(() => { setCardPage(1) }, [search, filterCat, filterValues, activeTab, viewMode])

  const totalCardPages = Math.max(1, Math.ceil(filtered.length / CARDS_PER_PAGE))
  const pagedCards = filtered.slice((cardPage - 1) * CARDS_PER_PAGE, cardPage * CARDS_PER_PAGE)

  const dashboardData = useMemo(() => computeDashboard(activeTab, filtered), [activeTab, filtered])

  const CardComponent = CARD_RENDERERS[activeTab]
  const DashboardPanel = DASHBOARD_PANELS[activeTab]
  const isTable = viewMode === 'table'
  const isCards = viewMode === 'cards'

  const contentClass = [
    'admin-content',
    isTable ? 'admin-content--table' : '',
    isCards ? 'admin-content--cards' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className="admin-page">

      <div className="sidebar-shell">
        <nav
          className={`admin-sidebar${(sidebarPinned || sidebarHovered) ? '' : ' admin-sidebar--collapsed'}`}
          onMouseEnter={() => setSidebarHovered(true)}
          onMouseLeave={() => setSidebarHovered(false)}
        >
          <div className="admin-sidebar__tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`admin-sidebar__btn${activeTab === t.id ? ' admin-sidebar__btn--active' : ''}`}
                onClick={() => setActiveTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </nav>
        <button
          className="admin-sidebar__toggle"
          onClick={() => setSidebarPinned((p) => !p)}
          title={sidebarPinned ? 'Collapse sidebar' : 'Pin sidebar open'}
        >
          {sidebarPinned ? '«' : '»'}
        </button>
      </div>

      <div className="admin-main">

        <div className="content-controls">
          <div className="content-controls__left">
            {filterConfigs.map((cfg, i) => {
              const opts = filterOptionsList[i] || []
              if (opts.length === 0 && !filterValues[i]) return null
              return (
                <FilterDropdown
                  key={cfg.label}
                  value={filterValues[i] || ''}
                  onChange={(v) => {
                    setFilterValues(prev => { const next = [...prev]; next[i] = v; return next })
                    setCardPage(1)
                  }}
                  options={opts.map(c => ({ value: c, label: c }))}
                  placeholder={`All ${cfg.label}s`}
                  disabled={loading}
                />
              )
            })}
            <input
              className="admin-search"
              type="search"
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              className="admin-clear-btn"
              onClick={() => { setFilterCat(''); setFilterValues([]); setSearch(''); setCardPage(1) }}
            >
              Clear Filter
            </button>
          </div>
          <div className="content-controls__right">
            <div className="view-toggle">
              {VIEWS.map((v) => (
                <button
                  key={v.id}
                  className={`view-toggle__btn${viewMode === v.id ? ' view-toggle__btn--active' : ''}`}
                  onClick={() => setViewMode(v.id)}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="content-header">
          <h2 className="content-header__title">
            {TABS.find((t) => t.id === activeTab)?.label}
          </h2>
          {categoryOptions.length > 0 && (
            <div className="category-chips">
              <button
                className={`category-chip${filterCat === '' ? ' category-chip--active' : ''}`}
                onClick={() => setFilterCat('')}
              >
                All
              </button>
              {categoryOptions.map((c) => (
                <button
                  key={c}
                  className={`category-chip${filterCat === c ? ' category-chip--active' : ''}`}
                  onClick={() => setFilterCat(c)}
                >
                  {c}
                </button>
              ))}
            </div>
          )}
        </div>

      <div className={contentClass}>
        {loading && <p className="admin-status">Loading…</p>}
        {error && <p className="admin-status admin-status--error">{error}</p>}

        {!loading && !error && viewMode === 'dashboard' && (
          <DashboardPanel data={dashboardData} />
        )}

        {!loading && !error && viewMode === 'cards' && (
          filtered.length === 0
            ? <p className="admin-status">No records found.</p>
            : (
              <>
                <div className="cards-scroll-area">
                  <div className="record-list">
                    {pagedCards.map((row, i) => <CardComponent key={i} row={row} />)}
                  </div>
                  <div className="cards-pagination">
                    <button
                      className="cards-pagination__btn"
                      onClick={() => setCardPage(1)}
                      disabled={cardPage === 1}
                    >&laquo;</button>
                    <button
                      className="cards-pagination__btn"
                      onClick={() => setCardPage((p) => Math.max(1, p - 1))}
                      disabled={cardPage === 1}
                    >&lsaquo;</button>
                    <span className="cards-pagination__label">
                      Page {cardPage} of {totalCardPages}
                    </span>
                    <button
                      className="cards-pagination__btn"
                      onClick={() => setCardPage((p) => Math.min(totalCardPages, p + 1))}
                      disabled={cardPage === totalCardPages}
                    >&rsaquo;</button>
                    <button
                      className="cards-pagination__btn"
                      onClick={() => setCardPage(totalCardPages)}
                      disabled={cardPage === totalCardPages}
                    >&raquo;</button>
                  </div>
                </div>
              </>
            )
        )}

        {!loading && !error && viewMode === 'table' && (
          <div className="table-wrap">
            <DataTable rows={rows.length > 0 ? [rows[0], ...filtered] : []} />
          </div>
        )}
      </div>

      </div>
    </div>
  )
}

export default Admin
