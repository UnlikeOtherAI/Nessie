import { useNativeIOSPhoneApp } from '../../lib/mobile-shell'

type PhoneBackButtonProps = {
  label: string
  onBack: () => void
  // 'icon' is the 36px circular doorway; 'labelled' adds a visible "Back" word
  // for column/detail headers that carry local (in-page) back ownership.
  variant?: 'icon' | 'labelled'
}

// The shared phone Back doorway. Route headers, column browsers, and channel
// flows all render this one control so a phone screen has exactly one leading
// navigation affordance with a consistent look and an explicit accessible
// label. The decorative chevron is aria-hidden.
export const PhoneBackButton = ({ label, onBack, variant = 'icon' }: PhoneBackButtonProps) => {
  const nativeIOSPhone = useNativeIOSPhoneApp()

  const iconClassName = variant === 'labelled' ? 'h-4 w-4' : 'h-5 w-5'
  const className =
    variant === 'labelled'
      ? [
          'flex h-8 flex-shrink-0 items-center gap-1.5 rounded-md pl-1.5 pr-2.5 text-sm',
          'text-[color:var(--tx2)] transition-colors hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
        ].join(' ')
      : [
          'flex h-9 w-9 flex-shrink-0 items-center justify-center transition-colors',
          nativeIOSPhone
            ? [
                'rounded-full border border-white/35 bg-white/65 text-[color:var(--tx)] shadow-sm',
                'backdrop-blur-xl active:bg-white/85 dark:border-white/20 dark:bg-black/25',
              ].join(' ')
            : 'rounded-full text-[color:var(--tx2)] hover:bg-[color:var(--overlay)] hover:text-[color:var(--tx)]',
        ].join(' ')

  return (
    <button
      aria-label={label}
      className={className}
      onClick={onBack}
      type="button"
    >
      <svg aria-hidden="true" className={iconClassName} fill="none" stroke="currentColor" strokeWidth="2.1" viewBox="0 0 24 24">
        <path d="m15 19-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {variant === 'labelled' ? <span>Back</span> : null}
    </button>
  )
}
