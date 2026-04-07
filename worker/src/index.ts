import { deriveRuntimeCapabilities, loadConfig } from '@nessie/config'

const config = loadConfig()

console.log(
  JSON.stringify(
    {
      service: 'worker',
      mode: config.mode,
      capabilities: deriveRuntimeCapabilities(config),
      status: 'step-0-skeleton',
    },
    null,
    2,
  ),
)
