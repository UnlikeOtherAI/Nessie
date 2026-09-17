import { Assistant } from './home/assistant'
import { AiBand, Pillars, WhatsNew } from './home/blocks'
import { FinalCta, Footer, Love, Promos, StatsBand, Stories } from './home/closing'
import { CookieBar, Header } from './home/header'
import { Hero } from './home/hero'
import { Pricing } from './home/pricing'
import { Departments } from './home/sales'
import { Wave } from './home/wave'
import { SignedInTeams } from './signed-in-teams/SignedInTeams'

// Waves only ever sit on the bottom edge of a dark section; a dark section's
// top edge is straight.
const light = '#fff'

export function App() {
  return (
    <>
      <Header />
      <main>
        {/* Before the pitch, for anyone who already has somewhere to be. */}
        <SignedInTeams />
        <Hero />
        <Assistant />
        <Departments />
        <AiBand />
        <Wave bottom={light} top="var(--n-ink)" />
        <WhatsNew />
        <Pillars />
        <Pricing />
        <Stories />
        <StatsBand />
        <Wave bottom={light} top="var(--n-deep)" />
        <Love />
        <Promos />
        <FinalCta />
      </main>
      <Wave bottom={light} top="var(--n-ink)" />
      <Footer />
      <CookieBar />
    </>
  )
}
