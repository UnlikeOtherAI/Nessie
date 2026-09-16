import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { useState, type KeyboardEvent } from 'react'

import { departments } from './content'

/**
 * Three jobs an AI employee does end to end, immediately before "Not bots.
 * Real teammates."
 *
 * Tabs rather than three stacked sections: they are alternatives, not a
 * sequence — a reader is one of sales, marketing or support and wants their
 * own, not all three. Unlike the hero's, these do not advance on their own;
 * this is mid-page, and a panel that changes while somebody is reading it is
 * an interruption rather than a demonstration.
 *
 * The keyboard contract is the WAI-ARIA tabs one: arrows move between tabs,
 * Home and End jump to the ends, and only the selected tab is in the tab order
 * so Tab leaves the strip rather than walking through every label.
 */
export function Departments() {
  const [active, setActive] = useState(0)
  const tabs = departments.tabs
  const panel = tabs[active] ?? tabs[0]
  if (!panel) return null

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 }
    const move = moves[event.key]
    const next = move !== undefined
      ? (active + move + tabs.length) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null
    if (next === null) return
    event.preventDefault()
    setActive(next)
    document.getElementById(`n-dept-tab-${tabs[next]?.id}`)?.focus()
  }

  return (
    <section aria-labelledby="n-dept-title" className="n-section n-dept" id="departments">
      <div className="n-container">
        <p className="n-kicker">{departments.kicker}</p>
        <h2 className="n-h2" id="n-dept-title">{panel.title}</h2>
        <div
          aria-label="What agents do"
          className="n-dept-tabs"
          onKeyDown={onKeyDown}
          role="tablist"
        >
          {tabs.map((tab, index) => (
            <button
              aria-controls="n-dept-panel"
              aria-selected={index === active}
              className={index === active ? 'n-dept-tab n-dept-tab-on' : 'n-dept-tab'}
              id={`n-dept-tab-${tab.id}`}
              key={tab.id}
              onClick={() => setActive(index)}
              role="tab"
              tabIndex={index === active ? 0 : -1}
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div
          aria-labelledby={`n-dept-tab-${panel.id}`}
          className="n-dept-panel"
          id="n-dept-panel"
          role="tabpanel"
          tabIndex={0}
        >
          <p className="n-lede">{panel.text}</p>
          <div className="n-dept-grid">
            {panel.cards.map((card) => (
              <article className="n-dept-card" key={card.title}>
                <span className="n-dept-icon">
                  <FontAwesomeIcon icon={card.icon} />
                </span>
                <h3>{card.title}</h3>
                <p>{card.text}</p>
              </article>
            ))}
          </div>
          <p className="n-dept-note">{panel.note}</p>
        </div>
      </div>
    </section>
  )
}
