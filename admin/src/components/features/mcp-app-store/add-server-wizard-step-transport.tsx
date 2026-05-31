import type { McpCatalogProtocol } from '@nessie/schemas'
import { ariaFor, renderFieldError } from './add-server-wizard-field'
import { PROTOCOLS } from './add-server-wizard-config'
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
  const { values, stepErrors, setProtocol, setUrl, setCommand, setArgs } =
    controller
  const { protocol } = values
  return (
    <div className="grid gap-3">
      <label className={labelClass}>
        Transport
        <select
          className={inputClass}
          onChange={(event) =>
            setProtocol(event.target.value as McpCatalogProtocol)
          }
          value={protocol}
        >
          {PROTOCOLS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      </label>
      {(protocol === 'http' || protocol === 'sse' || protocol === 'ws') && (
        <div>
          <label className={labelClass}>
            URL
            <input
              className={inputClass}
              data-testid="wizard-url"
              onChange={controller.onField(setUrl, 'url')}
              placeholder={
                protocol === 'ws'
                  ? 'wss://example.com/mcp'
                  : 'https://example.com/mcp'
              }
              type={protocol === 'ws' ? 'text' : 'url'}
              value={values.url}
              {...ariaFor('url', stepErrors)}
            />
          </label>
          {renderFieldError('url', stepErrors.url, 'wizard-url-error')}
        </div>
      )}
      {protocol === 'stdio' && (
        <>
          <div>
            <label className={labelClass}>
              Command
              <input
                className={inputClass}
                data-testid="wizard-command"
                onChange={controller.onField(setCommand, 'command')}
                placeholder="/usr/local/bin/my-mcp-server"
                value={values.command}
                {...ariaFor('command', stepErrors)}
              />
            </label>
            {renderFieldError('command', stepErrors.command)}
          </div>
          <label className={labelClass}>
            Args (space separated)
            <input
              className={inputClass}
              onChange={(event) => setArgs(event.target.value)}
              placeholder="--port 4000"
              value={values.args}
            />
          </label>
        </>
      )}
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
