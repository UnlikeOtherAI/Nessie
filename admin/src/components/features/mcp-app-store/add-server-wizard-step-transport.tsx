import { ariaFor, renderFieldError } from '../../shared/FormFieldError'
import {
  describeTransport,
  OFFERABLE_TRANSPORTS,
  type OfferableTransport,
} from './connector-transports'
import {
  buttonGhost,
  buttonPrimary,
  inputClass,
  labelClass,
} from './add-server-wizard-styles'
import type { AddServerWizardController } from './use-add-server-wizard'

type StepTransportProps = {
  controller: AddServerWizardController
  onCancel: () => void
}

/** Step 1: choose the transport protocol and its connection details. */
export const StepTransport = ({ controller, onCancel }: StepTransportProps) => {
  const { values, stepErrors, setProtocol, setUrl } = controller
  return (
    <div className="grid gap-3">
      <label className={labelClass}>
        Transport
        <select
          className={inputClass}
          onChange={(event) =>
            setProtocol(event.target.value as OfferableTransport)
          }
          value={values.protocol}
        >
          {OFFERABLE_TRANSPORTS.map((value) => (
            <option key={value} value={value}>
              {describeTransport(value)}
            </option>
          ))}
        </select>
      </label>
      <div>
        <label className={labelClass}>
          URL
          <input
            className={inputClass}
            data-testid="wizard-url"
            onChange={controller.onField(setUrl, 'url')}
            placeholder="https://example.com/mcp"
            type="url"
            value={values.url}
            {...ariaFor('url', stepErrors)}
          />
        </label>
        {renderFieldError('url', stepErrors.url, 'wizard-url-error')}
      </div>
      <p className="text-xs text-[color:var(--tx3)]">
        Connectors you add here are remote HTTP or SSE endpoints. A server that
        runs as a local process needs a remote MCP runner in front of it.
      </p>
      <div className="flex justify-end gap-2">
        <button className={buttonGhost} onClick={onCancel} type="button">
          Cancel
        </button>
        <button
          className={buttonPrimary}
          data-testid="wizard-transport-continue"
          onClick={controller.advanceFromTransport}
          type="button"
        >
          Continue
        </button>
      </div>
    </div>
  )
}
