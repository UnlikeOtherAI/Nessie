/**
 * The diagnostics a person can hand to support, closed by default so they never
 * compete with the plain-language failure above them. The lines are built by
 * `mailboxTechnicalDetails`, which is given no password and no local part.
 */
export const MailboxTechnicalDetails = ({ lines }: { lines: string[] }) => {
  if (lines.length === 0) return null
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-[color:var(--tx3)]">
        Technical details
      </summary>
      <ul className="mt-1 grid gap-0.5">
        {lines.map((line) => (
          <li className="text-xs break-words text-[color:var(--tx3)]" key={line}>{line}</li>
        ))}
      </ul>
    </details>
  )
}
