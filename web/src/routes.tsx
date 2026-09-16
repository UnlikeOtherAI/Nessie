// The site's routes.
//
// `web/public` is served by nginx with `try_files $uri $uri/ /index.html`
// (infrastructure/docker/web-nginx.conf), so a deep link to a documentation
// page is served the bundle and resolved here — no server change was needed to
// add pages, and none is needed to add more.
import { BrowserRouter, Route, Routes } from 'react-router-dom'

import { App } from './App'
import { LandingTeamsProvider } from './signed-in-teams/use-landing-teams'
import { NotFound } from './pages/not-found'
import { pages } from './pages/registry'
import { PageShell, ScrollToTop } from './pages/shell'

// Where the signed-in team list is read from. Production builds take the
// default; a local run points it at its own API.
const apiOrigin = import.meta.env.VITE_NESSIE_API_ORIGIN ?? 'https://api.nessie.works'

export const SiteRoutes = () => (
  <LandingTeamsProvider apiOrigin={apiOrigin}>
    <BrowserRouter>
      <ScrollToTop />
      <Routes>
        <Route element={<App />} path="/" />
        {pages.map((page) => (
          <Route element={<PageShell page={page} />} key={page.path} path={page.path} />
        ))}
        <Route element={<NotFound />} path="*" />
      </Routes>
    </BrowserRouter>
  </LandingTeamsProvider>
)
