import type { CredentialForm } from '../../../facades/board-sources/hooks'
import { Input } from '../../../components/shared/FormControls'
import { FormField } from '../../../components/shared/FormField'

type CredentialFormFieldsProps = {
  form: CredentialForm
  values: Record<string, string>
  onChange: (key: string, value: string) => void
  disabled?: boolean
}

/**
 * The fields of a pasted credential, rendered from the adapter's own
 * declaration rather than written per provider.
 *
 * One provider needs a single key, another needs an address and an email
 * beside it; a hand-written form each would be one more place to drift every
 * time a vendor changes what it issues. `secret` renders as a password field
 * so a key is not left legible on a shared screen — it is write-only, and no
 * route ever sends one back.
 */
export const CredentialFormFields = ({
  form,
  values,
  onChange,
  disabled = false,
}: CredentialFormFieldsProps) => (
  <div className="grid gap-3">
    {form.fields.map((field) => (
      <FormField help={field.help} key={field.key} label={field.label}>
        <Input
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => onChange(field.key, event.target.value)}
          placeholder={field.placeholder}
          spellCheck={false}
          type={
            field.kind === 'secret'
              ? 'password'
              : field.kind === 'email'
                ? 'email'
                : field.kind === 'url'
                  ? 'url'
                  : 'text'
          }
          value={values[field.key] ?? ''}
        />
      </FormField>
    ))}
    <p className="text-sm text-[color:var(--tx3)]">
      Make one at{' '}
      <a
        className="underline"
        href={form.createUrl}
        rel="noreferrer noopener"
        target="_blank"
      >
        {form.createLabel}
      </a>
      .
    </p>
  </div>
)
