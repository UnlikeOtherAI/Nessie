import { faPhone } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { assistant } from './content'

export function Assistant() {
  const { call } = assistant
  return (
    <section className="n-section n-assistant" id="assistant">
      <div className="n-container">
        <p className="n-kicker">{assistant.kicker}</p>
        <h2 className="n-h2">{assistant.title}</h2>
        <p className="n-lede">{assistant.text}</p>
        <div className="n-assistant-grid">
          <article className="n-call">
            <div aria-hidden="true" className="n-call-art">
              <span className="n-call-ring" />
              <span className="n-call-ring n-call-ring-late" />
              <span className="n-call-phone">
                <FontAwesomeIcon icon={faPhone} />
              </span>
              <span className="n-call-car">
                <FontAwesomeIcon icon={call.icon} />
              </span>
            </div>
            <span className="n-kicker">{call.kicker}</span>
            <h3>{call.title}</h3>
            <p>{call.text}</p>
          </article>
          <div className="n-assistant-cards">
            {assistant.cards.map((card) => (
              <article className="n-assistant-card" key={card.title}>
                <span className="n-assistant-icon">
                  <FontAwesomeIcon icon={card.icon} />
                </span>
                <div>
                  <h3>{card.title}</h3>
                  <p>{card.text}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
