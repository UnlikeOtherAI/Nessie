import { AiBand, Pillars, WhatsNew } from './home/blocks'
import { FinalCta, Footer, Love, Promos, StatsBand, Stories } from './home/closing'
import { CookieBar, Header } from './home/header'
import { Hero } from './home/hero'
import { Wave } from './home/wave'

// Light-to-dark changes use the "rise" wave, dark-to-light the "fall" wave.
const light = '#fff'

export function App() {
  return (
    <>
      <Header />
      <main>
        <Hero />
        <Wave bottom="var(--n-ink)" top="var(--n-foam)" />
        <AiBand />
        <Wave bottom={light} shape="fall" top="var(--n-ink)" />
        <WhatsNew />
        <Pillars />
        <Stories />
        <Wave bottom="var(--n-deep)" top={light} />
        <StatsBand />
        <Wave bottom={light} shape="fall" top="var(--n-deep)" />
        <Love />
        <Promos />
        <Wave bottom="var(--n-ink)" top={light} />
        <FinalCta />
      </main>
      <Wave bottom={light} shape="fall" top="var(--n-ink)" />
      <Footer />
      <CookieBar />
    </>
  )
}
