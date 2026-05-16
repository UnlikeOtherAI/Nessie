import { Link } from 'react-router-dom'

export const NotFoundPage = () => {
  return (
    <main
      className={[
        'flex min-h-screen items-center justify-center px-6 py-10',
      ].join(' ')}
    >
      <section
        className={[
          'admin-card flex w-full max-w-md flex-col items-center gap-4',
          'px-8 py-10 text-center',
        ].join(' ')}
      >
        <div className="text-xs font-semibold uppercase tracking-[0.3em] text-[color:var(--tx3)]">
          404
        </div>
        <h1 className="text-2xl font-semibold text-white">Page not found</h1>
        <p className="text-sm text-[color:var(--tx2)]">
          The page you were looking for does not exist or has moved.
        </p>
        <Link
          className="admin-button admin-button-primary mt-2"
          to="/channels"
        >
          Back to channels
        </Link>
      </section>
    </main>
  )
}
