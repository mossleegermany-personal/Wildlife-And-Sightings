import { useState, useEffect, useRef } from 'react'

function FilterDropdown({ value, onChange, options, placeholder, disabled }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    function handleOutside(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [])

  const selectedLabel = value
    ? (options.find((o) => o.value === value)?.label ?? value)
    : placeholder

  return (
    <div className={`filter-dropdown${disabled ? ' filter-dropdown--disabled' : ''}`} ref={ref}>
      <button
        type="button"
        className={`filter-dropdown__trigger${open ? ' filter-dropdown__trigger--open' : ''}${value ? ' filter-dropdown__trigger--active' : ''}`}
        onClick={() => { if (!disabled) setOpen((o) => !o) }}
        disabled={disabled}
      >
        <span className="filter-dropdown__label">{selectedLabel}</span>
      </button>
      {open && (
        <div className="filter-dropdown__list">
          <button
            type="button"
            className={`filter-dropdown__item${!value ? ' filter-dropdown__item--active' : ''}`}
            onClick={() => { onChange(''); setOpen(false) }}
          >
            {placeholder}
          </button>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`filter-dropdown__item${value === o.value ? ' filter-dropdown__item--active' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false) }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default FilterDropdown
