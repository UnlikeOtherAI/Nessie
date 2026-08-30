import type { ChangeEvent, ReactElement } from 'react'
import type { StepErrors } from './add-server-wizard-validation'
import { ariaFor, renderFieldError } from '../../shared/FormFieldError'

/**
 * OAuth2 sub-form for {@link ./AddServerWizard.tsx}. Per RFC 6749 §2.2 + §4.1
 * the confidential `authorization_code` flow requires `clientId` +
 * `clientSecret` alongside the authorization/token URLs; the catalog Zod
 * schema (`@nessie/schemas` `McpOAuth2AuthConfigSchema`) enforces both as
 * `min(1)`. Lives in its own file so the parent wizard stays under the
 * 500-line architectural cap.
 */

type ChangeHandler = (
  event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
) => void

type Oauth2FieldsProps = {
  values: {
    authorizationUrl: string
    tokenUrl: string
    clientId: string
    clientSecret: string
    scopes: string
  }
  onChange: {
    authorizationUrl: ChangeHandler
    tokenUrl: ChangeHandler
    clientId: ChangeHandler
    clientSecret: ChangeHandler
    scopes: ChangeHandler
  }
  classes: { label: string; input: string }
  errors: StepErrors
}

export const Oauth2Fields = ({
  values,
  onChange,
  classes,
  errors,
}: Oauth2FieldsProps): ReactElement => (
  <>
    <div>
      <label className={classes.label}>
        Client ID
        <input
          className={classes.input}
          data-testid="auth-client-id-input"
          onChange={onChange.clientId}
          placeholder="my-mcp-client"
          type="text"
          value={values.clientId}
          {...ariaFor('clientId', errors)}
        />
      </label>
      {renderFieldError('clientId', errors.clientId, 'auth-client-id-error')}
    </div>
    <div>
      <label className={classes.label}>
        Client Secret
        <input
          autoComplete="new-password"
          className={classes.input}
          data-testid="auth-client-secret-input"
          onChange={onChange.clientSecret}
          placeholder="••••••••"
          type="password"
          value={values.clientSecret}
          {...ariaFor('clientSecret', errors)}
        />
      </label>
      {renderFieldError(
        'clientSecret',
        errors.clientSecret,
        'auth-client-secret-error',
      )}
    </div>
    <div>
      <label className={classes.label}>
        Authorization URL
        <input
          className={classes.input}
          onChange={onChange.authorizationUrl}
          placeholder="https://auth.example.com/authorize"
          type="url"
          value={values.authorizationUrl}
          {...ariaFor('authorizationUrl', errors)}
        />
      </label>
      {renderFieldError('authorizationUrl', errors.authorizationUrl)}
    </div>
    <div>
      <label className={classes.label}>
        Token URL
        <input
          className={classes.input}
          onChange={onChange.tokenUrl}
          placeholder="https://auth.example.com/token"
          type="url"
          value={values.tokenUrl}
          {...ariaFor('tokenUrl', errors)}
        />
      </label>
      {renderFieldError('tokenUrl', errors.tokenUrl)}
    </div>
    <label className={classes.label}>
      Scopes (space or comma separated)
      <input
        className={classes.input}
        onChange={onChange.scopes}
        placeholder="repo read:user"
        value={values.scopes}
      />
    </label>
  </>
)
