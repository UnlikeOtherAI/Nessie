import type { InferenceResult } from '@nessie/runtime'

import { classifyError } from '../error-classification.js'
import type { PrepareProviderMessages } from '../inference.js'
import {
  renderPromptImages,
  type ToolImageCache,
  type ToolImageSource,
} from '../message-attachments.js'

export type ToolImageInference = {
  /**
   * One main-loop inference whose provider input carries the run's images.
   * `call` is handed the step that reads them in, to pass on as `runMain`'s
   * `prepareMessages`.
   */
  infer: (call: (prepareMessages: PrepareProviderMessages) => Promise<InferenceResult>) => Promise<InferenceResult>
}

/**
 * The images of a run's main loop, at the point a provider input is built.
 *
 * The transcript holds tool images as references (`tool-images.ts`); every
 * call reads them in again through `renderPromptImages`, told by the call's
 * own connector whether its model can see them. A connector's word is not
 * always the model's: a provider can still refuse a request because of its
 * images (`image_rejected`). The first time it does, the images are stripped
 * — the model is from then on treated as one that cannot see, so every image
 * line says so and names the text alternative — and the same call is made
 * once more instead of failing the run. The rest of the run stays that way.
 */
export const createToolImageInference = (source: ToolImageSource): ToolImageInference => {
  const cache: ToolImageCache = new Map()
  let imagesRefused = false
  let sentImages = false
  const prepareMessages: PrepareProviderMessages = async (messages, model) => {
    const rendered = await renderPromptImages(messages, source, {
      cache,
      supportsVision: model.supportsVision && !imagesRefused,
    })
    sentImages = rendered.some((message) => message.role === 'user' && (message.images?.length ?? 0) > 0)
    return rendered
  }
  return {
    infer: async (call) => {
      sentImages = false
      try {
        return await call(prepareMessages)
      } catch (error) {
        // Only a refusal of a request that carried pictures is one of them.
        if (imagesRefused || !sentImages || classifyError(error) !== 'image_rejected') throw error
        imagesRefused = true
        console.warn(
          `[worker] run ${source.runId}: the provider refused this call's images; asking again without them`,
        )
        return call(prepareMessages)
      }
    },
  }
}
