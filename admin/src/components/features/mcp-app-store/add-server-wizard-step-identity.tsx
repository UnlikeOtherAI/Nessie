import { ariaFor, renderFieldError } from '../../shared/FormFieldError'
import {
  buttonGhost,
  buttonPrimary,
  inputClass,
  labelClass,
} from './add-server-wizard-styles'
import type { AddServerWizardController } from './use-add-server-wizard'

type StepIdentityProps = {
  controller: AddServerWizardController
}

/** Step 2: catalog identity — name, label, optional vendor and description. */
export const StepIdentity = ({ controller }: StepIdentityProps) => {
  const { values, stepErrors, setName, setLabel, setVendor, setDescription } =
    controller
  return (
    <div className="grid gap-3">
      <div>
        <label className={labelClass}>
          Name (kebab-case, unique to you)
          <input
            className={inputClass}
            data-testid="wizard-name"
            onChange={controller.onField(setName, 'name')}
            placeholder="github-search"
            value={values.name}
            {...ariaFor('name', stepErrors)}
          />
        </label>
        {renderFieldError('name', stepErrors.name, 'wizard-name-error')}
      </div>
      <div>
        <label className={labelClass}>
          Label
          <input
            className={inputClass}
            data-testid="wizard-label"
            onChange={controller.onField(setLabel, 'label')}
            placeholder="GitHub Search"
            value={values.label}
            {...ariaFor('label', stepErrors)}
          />
        </label>
        {renderFieldError('label', stepErrors.label)}
      </div>
      <label className={labelClass}>
        Vendor (optional)
        <input
          className={inputClass}
          onChange={(event) => setVendor(event.target.value)}
          placeholder="GitHub"
          value={values.vendor}
        />
      </label>
      <label className={labelClass}>
        Description (optional)
        <textarea
          className={inputClass}
          onChange={(event) => setDescription(event.target.value)}
          rows={3}
          value={values.description}
        />
      </label>
      <div className="flex justify-between gap-2">
        <button
          className={buttonGhost}
          onClick={controller.goBack('transport')}
          type="button"
        >
          Back
        </button>
        <button
          className={buttonPrimary}
          data-testid="wizard-identity-continue"
          onClick={controller.advanceFromIdentity}
          type="button"
        >
          Continue
        </button>
      </div>
    </div>
  )
}
