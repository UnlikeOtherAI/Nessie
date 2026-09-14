import { Fragment } from 'react'
import { pillars } from './home/content'
import {
  AgentsIntro,
  Facts,
  FinalCta,
  Footer,
  Header,
  Hero,
  PillarSection,
  Quote,
  Resources,
  Updates,
} from './home/sections'

export function App() {
  return (
    <>
      <Header />
      <main>
        <Hero />
        <AgentsIntro />
        <Updates />
        {pillars.map((pillar, i) => (
          <Fragment key={pillar.id}>
            <PillarSection pillar={pillar} />
            {i === 1 && <Quote index={0} />}
          </Fragment>
        ))}
        <Quote index={1} />
        <Facts />
        <Resources />
        <FinalCta />
      </main>
      <Footer />
    </>
  )
}
