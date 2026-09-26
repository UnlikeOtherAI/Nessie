// Presence of this file is the CI image artifact contract for this revision.
// Revisions predating it still use Deploy's legacy Docker build path.
//
// `sha` is the gated main commit the image is published as. `sourceSha` is the
// commit the CI run built it from: the same commit, or — when the gate
// verified main through a branch run on the identical Git tree — that branch
// run's head commit. The archive's tag and revision label must name the source
// exactly; only the gate decides that the two commits hold the same tree.
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const COMMIT = /^[a-f0-9]{40}$/

export function promoteImage({ archive, name, sha, sourceSha = sha, prefix }, docker) {
  if (!archive || !['app', 'admin', 'web'].includes(name) || !COMMIT.test(sha ?? '')
    || !COMMIT.test(sourceSha ?? '') || !/^ghcr\.io\/[a-z0-9_-]+\/nessie$/.test(prefix ?? '')) {
    throw new Error('Invalid production image identity')
  }
  const source = `nessie-ci-${name}:${sourceSha}`
  const target = `${prefix}-${name}:${sha}`
  docker(['load', '--input', archive])
  const [image] = JSON.parse(docker(['image', 'inspect', source]))
  if (image?.Config?.Labels?.['org.opencontainers.image.revision'] !== sourceSha) {
    throw new Error('CI image revision does not match the gated source SHA')
  }
  docker(['tag', source, target])
  docker(['push', target])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const docker = (args) => {
    const result = spawnSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
    if (result.error || result.status !== 0) throw new Error(`docker ${args[0]} failed`)
    return result.stdout
  }
  promoteImage({
    archive: process.env.IMAGE_ARCHIVE,
    name: process.env.IMAGE_NAME,
    sha: process.env.IMAGE_SHA,
    sourceSha: process.env.IMAGE_SOURCE_SHA || process.env.IMAGE_SHA,
    prefix: process.env.IMAGE_PREFIX,
  }, docker)
}
