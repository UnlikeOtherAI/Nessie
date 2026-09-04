import { useEffect, useState } from 'react'

export type ShowcaseMessage = {
  action?: string
  agent?: boolean
  initials: string
  name: string
  text: string
  time: string
}

export type ShowcaseSlide = {
  body: string
  channel: string
  id: string
  members: string
  messages: ShowcaseMessage[]
  title: string
}

/**
 * Illustrative threads: the people, channels and times are made up to show
 * the shape of an assistant working inside a channel, not records from any
 * team. Copy is shared by both doorways.
 */
export const SIGN_IN_SHOWCASE_SLIDES: ShowcaseSlide[] = [
  {
    body: 'Ask in the thread and the assistant writes the note, checks it against the brief '
      + 'and posts it where the team already works.',
    channel: 'product-launch',
    id: 'draft',
    members: '14 members · 2 agents',
    messages: [
      {
        initials: 'MK',
        name: 'Marta K.',
        text: 'Can someone summarise yesterday\'s launch sync for the exec channel?',
        time: '09:41',
      },
      {
        action: 'Posted to #exec-updates · follow-up set for Thu 10:00',
        agent: true,
        initials: 'SC',
        name: 'Scribe',
        text: 'Drafted a 6-line summary from the meeting notes and the 3 open decisions. '
          + 'Posted to #exec-updates and tagged Jon for the pricing call.',
        time: '09:41',
      },
      { initials: 'JR', name: 'Jon R.', text: 'Perfect, exactly what I needed.', time: '09:44' },
    ],
    title: 'Agents that draft, not just answer',
  },
  {
    body: 'Assistants read the thread, pull the context from your tools and set the next step '
      + '— you only confirm.',
    channel: 'support-escalations',
    id: 'handoffs',
    members: '9 members · 1 agent',
    messages: [
      {
        initials: 'TN',
        name: 'Tomas N.',
        text: 'Ticket #4821 is stuck again — customer asked twice about the refund.',
        time: '14:02',
      },
      {
        action: 'Draft ready for review · task assigned to @finance',
        agent: true,
        initials: 'TR',
        name: 'Triage',
        text: 'Found the order and the previous two replies. Drafted the refund confirmation, '
          + 'opened a task for finance and moved the ticket to "waiting on us".',
        time: '14:02',
      },
      { initials: 'AL', name: 'Alena L.', text: 'Approved, send it.', time: '14:05' },
    ],
    title: 'Same channels. Fewer handoffs.',
  },
  {
    body: 'Every decision in a thread becomes a reminder, a task or a DM — without anyone '
      + 'copying it into another tool.',
    channel: 'weekly-planning',
    id: 'follow-ups',
    members: '22 members · 3 agents',
    messages: [
      {
        action: '3 reminders scheduled · 4 DMs sent',
        agent: true,
        initials: 'PL',
        name: 'Planner',
        text: 'Weekly plan is out. 4 items carried over from last week; owners have been pinged '
          + 'in DMs. Two blockers need a decision by Wednesday.',
        time: 'Mon 08:00',
      },
      {
        initials: 'EV',
        name: 'Eva V.',
        text: 'Move the API deprecation to next sprint, we\'re not ready.',
        time: '08:12',
      },
      {
        agent: true,
        initials: 'PL',
        name: 'Planner',
        text: 'Moved. Updated the roadmap doc and told #api-consumers about the new date.',
        time: '08:12',
      },
    ],
    title: 'Follow-ups that set themselves',
  },
]

const reducedMotion = (): boolean =>
  typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(prefers-reduced-motion: reduce)').matches

type SignInShowcaseProps = {
  slides?: ShowcaseSlide[]
  /** Seconds between slides; 0 disables the auto-advance. */
  intervalSeconds?: number
}

/**
 * The dark showcase panel: one illustrated thread at a time, a title and a
 * line under it, advancing on a timer until the reader picks a slide. Reduced
 * motion turns the timer off; the dots stay.
 */
export const SignInShowcase = ({
  intervalSeconds = 5,
  slides = SIGN_IN_SHOWCASE_SLIDES,
}: SignInShowcaseProps) => {
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const active = slides[index] ?? slides[0]

  useEffect(() => {
    if (paused || intervalSeconds <= 0 || slides.length < 2 || reducedMotion()) return undefined
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % slides.length)
    }, intervalSeconds * 1000)
    return () => window.clearInterval(timer)
  }, [intervalSeconds, paused, slides.length])

  if (!active) return null

  return (
    <div className="signin-showcase-panel">
      <div aria-hidden="true" className="signin-showcase-aura" />
      <div aria-hidden="true" className="signin-showcase-shade" />
      {slides.map((slide, slideIndex) => {
        const isActive = slideIndex === index
        return (
          <div
            aria-hidden={!isActive}
            className="signin-slide"
            data-active={isActive || undefined}
            key={slide.id}
          >
            <div className="signin-slide-card" key={isActive ? `${slide.id}-active` : slide.id}>
              <div className="signin-slide-head">
                <span className="signin-slide-hash">#</span>
                {slide.channel}
                <span className="signin-slide-members">{slide.members}</span>
              </div>
              <div className="signin-slide-body">
                {slide.messages.map((message, messageIndex) => (
                  <div className="signin-msg" key={`${slide.id}-${messageIndex}`}>
                    <div
                      aria-hidden="true"
                      className={message.agent ? 'signin-msg-tile signin-msg-tile-agent' : 'signin-msg-tile'}
                    >
                      {message.initials}
                    </div>
                    <div className="signin-msg-main">
                      <div className="signin-msg-meta">
                        <span className="signin-msg-name">{message.name}</span>
                        {message.agent ? <span className="signin-msg-agent">Agent</span> : null}
                        <span className="signin-msg-time">{message.time}</span>
                      </div>
                      <div className="signin-msg-text">{message.text}</div>
                      {message.action ? (
                        <div className="signin-msg-action">
                          <svg
                            aria-hidden="true"
                            fill="none"
                            height="13"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth="2.5"
                            viewBox="0 0 24 24"
                            width="13"
                          >
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                          {message.action}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )
      })}
      <div className="signin-showcase-foot">
        <div aria-label="Showcase slides" className="signin-dots" role="tablist">
          {slides.map((slide, slideIndex) => (
            <button
              aria-label={slide.title}
              aria-selected={slideIndex === index}
              className="signin-dot"
              key={slide.id}
              onClick={() => {
                setPaused(true)
                setIndex(slideIndex)
              }}
              role="tab"
              type="button"
            />
          ))}
        </div>
        <div aria-live="polite">
          <h2 className="signin-showcase-title">{active.title}</h2>
          <p className="signin-showcase-body">{active.body}</p>
        </div>
      </div>
    </div>
  )
}
