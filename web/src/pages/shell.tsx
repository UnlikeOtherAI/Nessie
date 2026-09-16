// The frame every page other than the homepage sits in.
//
// One shell, so a documentation page cannot drift into looking like a
// different website: the same navy header, the same wave under it, the same
// footer and cookie bar as the homepage, with a column of prose in between.
// A page module supplies only its content; the title, the lede, the tab title
// and the sidebar all come from `registry.ts`.
import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'

import { CookieBar, Header } from '../home/header'
import { Footer } from '../home/closing'
import { Wave } from '../home/wave'
import { docsPages, type Page } from './registry'

/**
 * A page is a place, so its tab and its description are part of it. Set on
 * mount rather than server-rendered — this is a static bundle, and a marketing
 * page whose tab says the wrong thing is worse than one whose crawler preview
 * is generic.
 */
const useDocumentTitle = (page: Page) => {
  useEffect(() => {
    const previousTitle = document.title
    document.title = `${page.title} — Nessie`
    const meta = document.querySelector('meta[name="description"]')
    const previousDescription = meta?.getAttribute('content') ?? null
    meta?.setAttribute('content', page.summary)
    return () => {
      document.title = previousTitle
      if (previousDescription !== null) meta?.setAttribute('content', previousDescription)
    }
  }, [page])
}

/** A router navigation keeps the old scroll position; a new page should not. */
export const ScrollToTop = () => {
  const { pathname } = useLocation()
  useEffect(() => { window.scrollTo(0, 0) }, [pathname])
  return null
}

const DocsSidebar = () => {
  const { pathname } = useLocation()
  return (
    <nav aria-label="Documentation" className="n-doc-side">
      <span className="n-doc-side-title">Documentation</span>
      <ul>
        {docsPages.map((page) => (
          <li key={page.path}>
            <Link
              aria-current={page.path === pathname ? 'page' : undefined}
              className={page.path === pathname ? 'n-doc-side-link n-doc-side-link-on' : 'n-doc-side-link'}
              to={page.path}
            >
              {page.navLabel ?? page.title}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export const PageShell = ({ page }: { page: Page }) => {
  useDocumentTitle(page)
  const { Component } = page
  const isDoc = page.path.startsWith('/docs/')
  return (
    <>
      <Header />
      <main className="n-page">
        <div className={isDoc ? 'n-page-inner n-page-inner-doc' : 'n-page-inner'}>
          {isDoc ? <DocsSidebar /> : null}
          <article className="n-prose">
            <h1>{page.title}</h1>
            <p className="n-page-lede">{page.summary}</p>
            <Component />
          </article>
        </div>
      </main>
      <Wave bottom="#fff" top="var(--n-ink)" />
      <Footer />
      <CookieBar />
    </>
  )
}
