import { AiBand, Pillars, WhatsNew } from './home/blocks'
import { FinalCta, Footer, Love, Promos, StatsBand, Stories } from './home/closing'
import { CookieBar, Header } from './home/header'
import { Hero } from './home/hero'

export function App() {
  return (
    <>
      <Header />
      <main>
        <Hero />
        <AiBand />
        <WhatsNew />
        <Pillars />
        <Stories />
        <StatsBand />
        <Love />
        <Promos />
        <FinalCta />
      </main>
      <Footer />
      <CookieBar />
    </>
  )
}
