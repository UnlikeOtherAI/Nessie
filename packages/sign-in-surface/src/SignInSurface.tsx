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
  title: 'The Slack alternative for an AI world',
} as const

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
  columnStyle?: CSSProperties
  className?: string
}

/**
 * The sign-in surface: a white card on the page ground, an aura-washed column
 * with the wordmark, headline and controls on the left, and a showcase panel
 * on the right from the `lg` breakpoint up. Layout and geometry live in
 * `styles.css`; every colour is a host token.
 */
export const SignInSurface = ({
  after,
  badge = SIGN_IN_COPY.badge,
  children,
  className,
  columnStyle,
  lede = SIGN_IN_COPY.lede,
  logo,
  productName,
  showcase,
  title = SIGN_IN_COPY.title,
}: SignInSurfaceProps) => (
  <main className={['signin-page', className].filter(Boolean).join(' ')}>
    <div className={showcase ? 'signin-card signin-card-with-showcase' : 'signin-card'}>
      <section aria-label="Sign in" className="signin-auth">
        <div aria-hidden="true" className="signin-aura" />
        <div aria-hidden="true" className="signin-aura-fade" />
        <div className="signin-auth-scroll">
          <div className="signin-column" style={columnStyle}>
            <div className="signin-wordmark">
              {logo}
              <span>{productName}</span>
            </div>
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
