import type { CSSProperties, ReactNode } from 'react'

/**
 * The words both doorways share. The admin login and the public landing say
 * the same thing about the product because they are the same screen; a change
 * here is a change to both.
 */
export const SIGN_IN_COPY = {
  badge: 'Private beta · invite only',
  lede:
    'Your team and its agents in one team. Same channels, threads and DMs you already know '
    + '— except the assistants in them can draft the note, post it to the right channel and '
    + 'set the follow-up themselves.',
  title: 'The European Slack alternative for an AI world',
} as const

/**
 * The homepage's water edge, hanging off the bottom of the brand bar: a
 * translucent swell behind a solid crest, both in the bar's own colour, so the
 * bar drips over the hero beneath it. The shape is the marketing site's
 * `rise`, flipped — same silhouette, so the two doorways read as one brand.
 */
const BrandWave = () => (
  <div aria-hidden="true" className="signin-wave">
    <svg preserveAspectRatio="none" viewBox="0 0 1440 120">
      <path
        d="M0 84 L520 84 C600 84 640 58 720 52 S860 20 960 24 S1110 72 1200 66 S1360 14 1440 22 L1440 120 L0 120 Z"
        fill="currentColor"
        opacity="0.45"
      />
      <path
        d="M0 84 L480 84 C560 84 600 62 670 56 S790 92 880 90 S1010 38 1090 36 S1220 88 1300 84 S1410 48 1440 50 L1440 120 L0 120 Z"
        fill="currentColor"
      />
    </svg>
  </div>
)

export type SignInSurfaceProps = {
  /** The product mark, already sized: an `<img className="signin-wordmark-mark">`. */
  logo: ReactNode
  productName: string
  badge?: ReactNode | null
  title?: ReactNode
  lede?: ReactNode
  /** The sign-in controls: buttons, errors, the local-development form. */
  children: ReactNode
  /** Everything after the controls — typically {@link AppDownloads}. */
  after?: ReactNode
  /** The right-hand panel on wide viewports — typically {@link SignInShowcase}. */
  showcase?: ReactNode
  /**
   * Let the document scroll past the hero: the page is at least the viewport
   * instead of exactly it, and the column stops scrolling inside the hero, so
   * a host with content after the doorway (the landing) reads as one page.
   * The admin, whose body never scrolls, leaves it off.
   */
  flow?: boolean
  columnStyle?: CSSProperties
  className?: string
}

/**
 * The sign-in surface: the marketing homepage's doorway. A brand bar in the
 * chrome's ink with the mark and the wordmark, the water edge hanging off it,
 * then the hero — copy and controls on the left over the wash gradient, and a
 * showcase panel on the right from the `lg` breakpoint up. Layout, type and
 * geometry live in `styles.css`; every colour is a host token.
 */
export const SignInSurface = ({
  after,
  badge = SIGN_IN_COPY.badge,
  children,
  className,
  columnStyle,
  flow = false,
  lede = SIGN_IN_COPY.lede,
  logo,
  productName,
  showcase,
  title = SIGN_IN_COPY.title,
}: SignInSurfaceProps) => (
  <main
    className={['signin-page', flow && 'signin-page-flow', className].filter(Boolean).join(' ')}
  >
    <div className="signin-topbar">
      <div className="signin-topbar-inner">
        <span className="signin-wordmark">
          {logo}
          <span>{productName}</span>
        </span>
      </div>
      <BrandWave />
    </div>
    <div className={showcase ? 'signin-hero signin-hero-with-showcase' : 'signin-hero'}>
      <section aria-label="Sign in" className="signin-auth">
        <div className="signin-auth-scroll">
          <div className="signin-column" style={columnStyle}>
            {badge ? (
              <p className="signin-pill">
                <span aria-hidden="true" className="signin-pill-dot" />
                {badge}
              </p>
            ) : null}
            <h1 className="signin-title">{title}</h1>
            <p className="signin-lede">{lede}</p>
            <div className="signin-actions">{children}</div>
            {after}
          </div>
        </div>
      </section>
      {showcase ? <aside className="signin-showcase">{showcase}</aside> : null}
    </div>
  </main>
)
