// Tablet and desktop: a detail → nested push slides inside the detail column
// (docs/navigation/overview.md §5). Agents → the agent designer: the designer enters
// from the column's right edge and the list parallaxes beneath it, while the
// pinned sidebar never moves.
import { createChecks } from '../lib/expect.mjs'
import { gotoPath, pushPath } from '../lib/page.mjs'
import { captureTransition } from '../lib/transition.mjs'

const splitPushCase = (viewport) => ({
  name: `${viewport}-split-push`,
  run: async ({ page }) => {
    const caseName = `${viewport}-split-push`
    const checks = createChecks(caseName)
    const result = await captureTransition({
      caseName,
      page,
      prepare: (target) => gotoPath(target, '/agents'),
      travels: [
        { from: 1, label: 'entering designer', to: 0 },
        { from: 0, label: 'parallaxing agents list', to: -0.28 },
      ],
      trigger: async (target) => {
        const before = await target.evaluate(() => document.querySelector('.resizable-sidebar')?.getBoundingClientRect().width ?? null)
        await pushPath(target, '/agents/designer')
        return { before }
      },
    })
    const shell = await page.evaluate(() => document.querySelector('[data-navigation]')?.getAttribute('data-navigation'))
    checks.equal(`${caseName}: the shell declares the split layout`, shell, 'split')
    checks.close()
    return { checks: [...result.checks, ...checks.checks], frames: result.frames }
  },
  viewport,
})

export const tabletSplitPush = splitPushCase('tablet')
export const desktopSplitPush = splitPushCase('desktop')
