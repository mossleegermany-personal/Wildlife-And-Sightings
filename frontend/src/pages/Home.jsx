import { useState } from 'react'
import IdentifyAnimal from '../components/ui/IdentifyAnimal'
import '../css/pages/Admin.css'
import '../css/pages/Home.css'

const SECTIONS = [
  { id: 'animal-identification', label: 'Animal Identification' },
  { id: 'bird-sightings',        label: 'Bird Sightings' },
]

const BIRD_FEATURES = [
  {
    id: 'nearby',
    label: 'Nearby Sightings',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z" />
      </svg>
    ),
    desc: 'Find bird sightings recorded close to any location.',
  },
  {
    id: 'notable',
    label: 'Notable Sightings',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
      </svg>
    ),
    desc: 'Discover rare and unusual species recently reported.',
  },
  {
    id: 'hotspots',
    label: 'Hotspots',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0z" />
      </svg>
    ),
    desc: 'Browse top birding locations and their recent activity.',
  },
  {
    id: 'species',
    label: 'Species Search',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803 7.5 7.5 0 0016.803 15.803z" />
      </svg>
    ),
    desc: 'Search any bird species and explore their global range.',
  },
  {
    id: 'my-logs',
    label: 'My Records',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
      </svg>
    ),
    desc: 'Review your personal sighting history and logs.',
  },
]

const AI_FEATURES = [
  { label: 'Species & Taxonomy',    desc: 'Full taxonomic classification down to subspecies level.' },
  { label: 'Sex & Life Stage',      desc: 'Determines sex, age, and breeding plumage where visible.' },
  { label: 'IUCN Conservation',     desc: 'Global and local threat status for every identification.' },
  { label: 'eBird & GBIF Verified', desc: 'Cross-referenced against two global scientific databases.' },
]

function AnimalIdentificationLanding({ onStart }) {
  return (
    <div className="hs-page">
      {/* Hero */}
      <div className="hs-hero">
        <div className="hs-hero__icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
          </svg>
        </div>
        <div className="hs-hero__text">
          <h2 className="hs-hero__title">Animal Identification</h2>
          <p className="hs-hero__desc">
            Upload any wildlife photo and our Gemini-powered AI will identify the species, classify its taxonomy, assess conservation status, and verify against global scientific databases — in seconds.
          </p>
          <button className="hs-hero__cta" onClick={onStart}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
            Upload a Photo to Identify
          </button>
        </div>
      </div>

      {/* Feature grid */}
      <div className="hs-features">
        <p className="hs-features__label">What you get</p>
        <div className="hs-features__grid">
          {AI_FEATURES.map((f) => (
            <div key={f.label} className="hs-feat-card">
              <span className="hs-feat-card__dot" />
              <div>
                <p className="hs-feat-card__title">{f.label}</p>
                <p className="hs-feat-card__desc">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Supports chip row */}
      <div className="hs-chips">
        <span className="hs-chips__label">Identifies</span>
        {['Birds', 'Mammals', 'Reptiles', 'Amphibians', 'Insects', 'Fish', 'Marine life', 'Plants & more'].map((c) => (
          <span key={c} className="hs-chip">{c}</span>
        ))}
      </div>
    </div>
  )
}

function BirdSightingsLanding({ onFeature, activeItem }) {
  return (
    <div className="hs-page">
      <div className="hs-hero hs-hero--compact">
        <div className="hs-hero__icon hs-hero__icon--sky">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 3c-4.97 0-9 3.185-9 7.115 0 2.557 1.522 4.82 3.889 6.204L6 19.5l4.125-1.65A10.87 10.87 0 0012 18c4.97 0 9-3.185 9-7.115C21 6.184 16.97 3 12 3z" />
          </svg>
        </div>
        <div className="hs-hero__text">
          <h2 className="hs-hero__title">Bird Sightings</h2>
          <p className="hs-hero__desc">
            Explore real-time bird sightings powered by eBird. Find birds near you, discover rare species, locate top birding hotspots, and browse your personal records.
          </p>
        </div>
      </div>

      {/* Feature cards */}
      <div className="hs-cards">
        {BIRD_FEATURES.map((f) => (
          <button
            key={f.id}
            className={`hs-card${activeItem === f.id ? ' hs-card--active' : ''}`}
            onClick={() => onFeature(f.id)}
          >
            <span className="hs-card__icon">{f.icon}</span>
            <span className="hs-card__title">{f.label}</span>
            <span className="hs-card__desc">{f.desc}</span>
            <span className="hs-card__arrow">→</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function Home() {
  const [sidebarPinned, setSidebarPinned] = useState(false)
  const [sidebarHovered, setSidebarHovered] = useState(false)
  const [activeSection, setActiveSection] = useState(null)
  const [activeItem, setActiveItem] = useState(null)
  const sidebarExpanded = sidebarPinned || sidebarHovered

  function handleSectionClick(sectionId) {
    setActiveSection(sectionId)
    setActiveItem(null)
  }

  return (
    <div className="admin-page">
      <div className="sidebar-shell">
        <nav
          className={`admin-sidebar${sidebarExpanded ? '' : ' admin-sidebar--collapsed'}`}
          onMouseEnter={() => setSidebarHovered(true)}
          onMouseLeave={() => setSidebarHovered(false)}
        >
          <div className="admin-sidebar__tabs">
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                className={`admin-sidebar__btn${activeSection === section.id ? ' admin-sidebar__btn--active' : ''}`}
                onClick={() => handleSectionClick(section.id)}
              >
                {section.label}
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
        {!activeSection && (
          <div className="home-empty">
            <div className="home-empty__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
              </svg>
            </div>

          </div>
        )}

        {activeSection === 'animal-identification' && activeItem === null && (
          <AnimalIdentificationLanding onStart={() => setActiveItem('identify-animal')} />
        )}

        {activeSection === 'animal-identification' && activeItem === 'identify-animal' && (
          <IdentifyAnimal />
        )}

        {activeSection === 'bird-sightings' && (
          <BirdSightingsLanding
            activeItem={activeItem}
            onFeature={(id) => setActiveItem(id)}
          />
        )}
      </div>
    </div>
  )
}

export default Home
