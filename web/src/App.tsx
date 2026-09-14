import { Assistant } from './home/assistant'
import { AiBand, Pillars, WhatsNew } from './home/blocks'
import { FinalCta, Footer, Love, Promos, StatsBand, Stories } from './home/closing'
import { CookieBar, Header } from './home/header'
import { Hero } from './home/hero'
import { Wave } from './home/wave'

// Waves only ever sit on the bottom edge of a dark section; a dark section's
// top edge is straight.
const light = '#fff'

export function App() {
  return (
    <>
      <Header />
      <main>
        <Hero />
        <Assistant />
        <AiBand />
        <Wave bottom={light} top="var(--n-ink)" />
        <WhatsNew />
        <Pillars />
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
