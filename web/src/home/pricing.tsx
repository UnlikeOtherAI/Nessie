import { faArrowRight, faCheck, faKey, faServer } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { docsUrl, pricing, signInUrl } from './content'
import { Button } from './ui'

export function Pricing() {
  const { plan, selfHost, byo } = pricing
  return (
    <section className="n-section n-pricing" id="pricing">
      <div className="n-container">
        <div className="n-pricing-head">
          <p className="n-kicker">{pricing.kicker}</p>
          <h2 className="n-h2">{pricing.title}</h2>
          <p className="n-lede">{pricing.text}</p>
        </div>
        <div className="n-pricing-grid">
          <article className="n-price-card">
            <h3>{plan.name}</h3>
            <div className="n-price">
              <strong>{plan.price.amount}</strong>
              <span>{plan.price.unit}</span>
            </div>
            <p className="n-price-storage">
              + <strong>{plan.storage.amount}</strong> {plan.storage.unit}
            </p>
            <p className="n-price-note">{plan.usageNote}</p>
            <ul className="n-price-features">
              {plan.features.map((feature) => (
                <li key={feature}>
                  <FontAwesomeIcon className="n-price-check" icon={faCheck} />
                  {feature}
                </li>
              ))}
            </ul>
            <Button href={signInUrl}>{plan.cta}</Button>
          </article>
          <aside className="n-price-self">
            <span className="n-assistant-icon">
              <FontAwesomeIcon icon={faServer} />
            </span>
            <h3>{selfHost.title}</h3>
            <p>{selfHost.text}</p>
            <a className="n-text-link" href={docsUrl}>
              {selfHost.cta} <FontAwesomeIcon icon={faArrowRight} />
            </a>
          </aside>
          <article className="n-byo">
            <span className="n-byo-icon">
              <FontAwesomeIcon icon={faKey} />
            </span>
            <div className="n-byo-copy">
              <h3>{byo.title}</h3>
              <p>{byo.text}</p>
              <ul className="n-byo-providers">
                {byo.providers.map((provider) => (
                  <li key={provider}>{provider}</li>
                ))}
                <li className="n-byo-more">{byo.more}</li>
              </ul>
            </div>
          </article>
        </div>
      </div>
    </section>
  )
}
