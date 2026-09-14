import { faArrowRight, faCheck, faServer } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { docsUrl, pricing, signInUrl } from './content'
import { Button } from './ui'

export function Pricing() {
  const { plan, selfHost } = pricing
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
            <div className="n-price-rows">
              {plan.prices.map((price, i) => (
                <div className="n-price" key={price.unit}>
                  {i > 0 && <span className="n-price-plus">+</span>}
                  <strong>{price.amount}</strong>
                  <span>{price.unit}</span>
                </div>
              ))}
            </div>
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
        </div>
      </div>
    </section>
  )
}
