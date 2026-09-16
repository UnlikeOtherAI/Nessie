import { Link } from 'react-router-dom'

import { Footer } from '../home/closing'
import { CookieBar, Header } from '../home/header'
import { Wave } from '../home/wave'
import { docsPages } from './registry'

/**
 * A mistyped or retired URL lands here rather than on a blank bundle. It names
 * the pages that do exist, because the commonest reason to arrive is a link
 * that moved.
 */
export const NotFound = () => (
  <>
    <Header />
    <main className="n-page">
      <div className="n-page-inner">
        <article className="n-prose">
          <h1>That page is not here.</h1>
          <p className="n-page-lede">
            The address may have changed, or it may never have existed. These are the pages that do.
          </p>
          <ul>
            <li><Link to="/">The homepage</Link></li>
            {docsPages.map((page) => (
              <li key={page.path}><Link to={page.path}>{page.navLabel ?? page.title}</Link></li>
            ))}
          </ul>
        </article>
      </div>
    </main>
    <Wave bottom="#fff" top="var(--n-ink)" />
    <Footer />
    <CookieBar />
  </>
)
