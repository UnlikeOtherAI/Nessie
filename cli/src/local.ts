import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deriveRuntimeCapabilities, loadConfig, type NessieConfig } from '@nessie/config'

type LaunchMode = 'docker' | 'no-docker'
type ServiceName = 'admin' | 'api' | 'worker'

type LocalState = {
  adminUrl: string
  apiUrl: string
  composeFile: string
  configPath: string
  databaseUrl: string
  logsDir: string
  mode: LaunchMode
  services: Record<
    ServiceName,
    {
      logFile: string
      pid: number
    }
  >
  startedAt: string
  stateDir: string
  version: 1
}

type LocalPaths = {
  adminRoot: string
  apiRoot: string
  composeFile: string
  configPath: string
  dockerDataDir: string
  logsDir: string
  repoRoot: string
  stateDir: string
  stateFile: string
  storageDir: string
  workerRoot: string
}

type DoctorSummary = {
  config: NessieConfig
  dockerAvailable: boolean
  env: NodeJS.ProcessEnv
  paths: LocalPaths
  postgresReady: boolean
  pnpmAvailable: boolean
}

const API_PORT = 5454
const ADMIN_PORT = 4173
const LAN_BIND_HOST = '0.0.0.0'
const DOCKER_POSTGRES_PORT = 55432
const STATE_VERSION = 1 as const
const DOCKER_DB_URL = `postgresql://nessie:nessie@127.0.0.1:${DOCKER_POSTGRES_PORT}/nessie`
const LOG_TAIL_BYTES = 16_384

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const buildPaths = (): LocalPaths => {
  const stateDir = resolve(repoRoot, '.nessie', 'local')
  return {
    adminRoot: resolve(repoRoot, 'admin'),
    apiRoot: resolve(repoRoot, 'api'),
    composeFile: resolve(repoRoot, 'infrastructure', 'compose', 'docker-compose.yml'),
    configPath: resolve(stateDir, 'nessie.config.json'),
    dockerDataDir: resolve(repoRoot, '.nessie', 'docker', 'postgres'),
    logsDir: resolve(stateDir, 'logs'),
    repoRoot,
    stateDir,
    stateFile: resolve(stateDir, 'state.json'),
    storageDir: resolve(repoRoot, '.nessie', 'storage'),
    workerRoot: resolve(repoRoot, 'worker'),
  }
}

const paths = buildPaths()

const loadDotEnv = (filePath: string): NodeJS.ProcessEnv => {
  if (!existsSync(filePath)) {
    return {}
  }

  const env: NodeJS.ProcessEnv = {}
  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const equalsIndex = line.indexOf('=')
    if (equalsIndex <= 0) {
      continue
    }

    const key = line.slice(0, equalsIndex).trim()
    let value = line.slice(equalsIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    env[key] = value
  }

  return env
}

const resolveEnv = (): NodeJS.ProcessEnv => ({
  ...loadDotEnv(resolve(repoRoot, '.env')),
  ...process.env,
})

const getLocalPostgresUser = (env: NodeJS.ProcessEnv): string =>
  env.PGUSER ??
  env.USER ??
  env.LOGNAME ??
  env.USERNAME ??
  'postgres'

const getDefaultNoDockerDatabaseUrl = (env: NodeJS.ProcessEnv): string => {
  const user = encodeURIComponent(getLocalPostgresUser(env))
  const port = env.PGPORT ?? '5432'
  const host = env.PGHOST ?? '127.0.0.1'
  // Canonical local database name, matching @nessie/config's default and the
  // api migrate scripts so the app and migration tooling never diverge.
  return `postgresql://${user}@${host}:${port}/nessie`
}

const ensureDirectories = (): void => {
  mkdirSync(paths.logsDir, { recursive: true })
  mkdirSync(paths.storageDir, { recursive: true })
  mkdirSync(paths.dockerDataDir, { recursive: true })
}

const readState = (): LocalState | null => {
  if (!existsSync(paths.stateFile)) {
    return null
  }

  return JSON.parse(readFileSync(paths.stateFile, 'utf8')) as LocalState
}

const writeState = (state: LocalState): void => {
  mkdirSync(paths.stateDir, { recursive: true })
  writeFileSync(paths.stateFile, JSON.stringify(state, null, 2))
}

const removeState = (): void => {
  if (existsSync(paths.stateFile)) {
    rmSync(paths.stateFile, { force: true })
  }
}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const getPnpmCommand = (): string =>
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

const resolveLocalBin = (cwd: string, name: 'tsx' | 'vite'): string =>
  resolve(
    cwd,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? `${name}.cmd` : name,
  )

const runChecked = (
  command: string,
  args: string[],
  input: {
    env?: NodeJS.ProcessEnv
    stdio?: 'ignore' | 'inherit' | 'pipe'
  } = {},
): void => {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: input.env ?? process.env,
    stdio: input.stdio ?? 'inherit',
  })

  if (result.status === 0) {
    return
  }

  const stderr = result.stderr?.toString().trim()
  const stdout = result.stdout?.toString().trim()
  throw new Error(stderr || stdout || `${command} ${args.join(' ')} failed`)
}

const parseDatabaseUrl = (databaseUrl: string): { host: string; port: number } => {
  const url = new URL(databaseUrl)
  return {
    host: url.hostname || '127.0.0.1',
    port: Number(url.port || '5432'),
  }
}

const ensureLocalDatabase = (databaseUrl: string): void => {
  const url = new URL(databaseUrl)
  const databaseName = url.pathname.replace(/^\//, '')
  const host = url.hostname || '127.0.0.1'
  const port = url.port || '5432'
  const username = decodeURIComponent(url.username || '')

  const connectionArgs = ['-h', host, '-p', port]
  if (username) {
    connectionArgs.push('-U', username)
  }

  const query = `select 1 from pg_database where datname = '${databaseName}'`
  const result = spawnSync(
    process.platform === 'win32' ? 'psql.exe' : 'psql',
    [...connectionArgs, '-d', 'postgres', '-Atqc', query],
    {
      encoding: 'utf8',
      env: process.env,
      stdio: 'pipe',
    },
  )

  if (result.status === 0 && result.stdout.trim() === '1') {
    return
  }

  runChecked(
    process.platform === 'win32' ? 'createdb.exe' : 'createdb',
    [...connectionArgs, databaseName],
    { stdio: 'ignore' },
  )
}

const canAuthenticateToDatabase = (databaseUrl: string): boolean => {
  const result = spawnSync(
    process.platform === 'win32' ? 'psql.exe' : 'psql',
    [databaseUrl, '-Atqc', 'select 1'],
    {
      encoding: 'utf8',
      env: process.env,
      stdio: 'pipe',
    },
  )

  return result.status === 0 && result.stdout.trim() === '1'
}

const canReachPostgresServer = (databaseUrl: string): boolean => {
  const url = new URL(databaseUrl)
  url.pathname = '/postgres'

  return canAuthenticateToDatabase(url.toString())
}

const wait = async (ms: number): Promise<void> =>
  new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms)
  })

const canReachTcpPort = async (host: string, port: number): Promise<boolean> => {
  const net = await import('node:net')

  return new Promise((resolvePromise) => {
    const socket = net.createConnection({ host, port })
    const finish = (result: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolvePromise(result)
    }

    socket.setTimeout(1_500)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

const waitForTcpPort = async (
  host: string,
  port: number,
  timeoutMs = 20_000,
): Promise<void> => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await canReachTcpPort(host, port)) {
      return
    }

    await wait(500)
  }

  throw new Error(`Timed out waiting for ${host}:${port}`)
}

const waitForHttp = async (url: string, timeoutMs = 20_000): Promise<void> => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok || response.status === 401) {
        return
      }
    } catch {
      // Retry until timeout.
    }
    await wait(500)
  }

  throw new Error(`Timed out waiting for ${url}`)
}

const waitForLogMatch = async (
  logFile: string,
  pattern: RegExp,
  timeoutMs = 20_000,
): Promise<string | null> => {
  const globalPattern = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  )

  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(logFile)) {
      const text = readFileSync(logFile, 'utf8')
      const matches = Array.from(text.matchAll(globalPattern))
      const lastMatch = matches.at(-1)
      if (lastMatch?.[0]) {
        return lastMatch[0]
      }
    }
    await wait(500)
  }

  return null
}

const waitForPostgresReady = async (
  databaseUrl: string,
  timeoutMs = 20_000,
): Promise<void> => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (canAuthenticateToDatabase(databaseUrl)) {
      return
    }

    await wait(500)
  }

  throw new Error(`Timed out waiting for Postgres readiness at ${databaseUrl}`)
}

const createGeneratedConfig = (mode: LaunchMode, env: NodeJS.ProcessEnv): NessieConfig => {
  const baseConfig = loadConfig({
    argv: [],
    cwd: repoRoot,
    env: {
      DATABASE_URL: env.DATABASE_URL ?? getDefaultNoDockerDatabaseUrl(env),
      ...env,
    },
  })

  const config: NessieConfig = {
    ...baseConfig,
    api: {
      host: LAN_BIND_HOST,
      port: API_PORT,
    },
    auth: {
      ...baseConfig.auth,
      autoRedirectToSso: false,
      secret: baseConfig.auth.secret ?? 'nessie-local-dev-secret',
      providers: [],
    },
    database: {
      ...baseConfig.database,
      url: mode === 'docker' ? DOCKER_DB_URL : baseConfig.database.url,
    },
    mode: 'local',
    queue: {
      projectId: undefined,
      provider: 'local',
    },
    storage: {
      bucket: undefined,
      localPath: paths.storageDir,
      provider: 'filesystem',
    },
  }

  writeFileSync(paths.configPath, JSON.stringify(config, null, 2))
  return config
}

const getServiceLogFile = (service: ServiceName): string =>
  resolve(paths.logsDir, `${service}.log`)

const spawnDetachedService = (
  service: ServiceName,
  cwd: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { logFile: string; pid: number } => {
  const logFile = getServiceLogFile(service)
  rmSync(logFile, { force: true })
  const logHandle = openSync(logFile, 'w')
  const child = spawn(command, args, {
    cwd,
    detached: true,
    env,
    stdio: ['ignore', logHandle, logHandle],
  })

  child.unref()

  if (!child.pid) {
    throw new Error(`Failed to start ${service}`)
  }

  return {
    logFile,
    pid: child.pid,
  }
}

const stopProcessGroup = (pid: number): void => {
  if (!isProcessAlive(pid)) {
    return
  }

  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    process.kill(pid, 'SIGTERM')
  }
}

const runDockerCompose = (
  args: string[],
  env: NodeJS.ProcessEnv,
  stdio: 'ignore' | 'inherit' | 'pipe' = 'inherit',
): void => {
  runChecked(
    process.platform === 'win32' ? 'docker.exe' : 'docker',
    ['compose', '-f', paths.composeFile, '-p', 'nessie-local', ...args],
    { env, stdio },
  )
}

const resolveLaunchMode = (
  args: string[],
  dockerAvailable: boolean,
): LaunchMode => {
  if (args.includes('--docker')) {
    return 'docker'
  }

  if (args.includes('--no-docker')) {
    return 'no-docker'
  }

  return dockerAvailable ? 'docker' : 'no-docker'
}

const renderDoctor = (summary: DoctorSummary): void => {
  const capabilities = deriveRuntimeCapabilities(summary.config)

  console.log(`repo: ${summary.paths.repoRoot}`)
  console.log(`pnpm: ${summary.pnpmAvailable ? 'ok' : 'missing'}`)
  console.log(`docker: ${summary.dockerAvailable ? 'ok' : 'missing'}`)
  console.log(`postgres (${summary.config.database.url}): ${summary.postgresReady ? 'ok' : 'not ready'}`)
  console.log(`model provider: ${capabilities.hasModelProvider ? 'ok' : 'missing api key'}`)
  console.log(`object storage: ${summary.config.storage.provider}`)
  console.log(`recommended mode: ${summary.dockerAvailable ? 'docker' : 'no-docker'}`)

  if (!summary.postgresReady) {
    console.log(
      'guidance: start Postgres with access for the current user, set DATABASE_URL, or use `nessie local up --docker`.',
    )
  }

  if (!capabilities.hasModelProvider) {
    console.log('guidance: set OPENAI_CHAT_API_KEY, OPENAI_API_KEY, or MINIMAX_API_KEY.')
  }
}

const collectDoctorSummary = async (): Promise<DoctorSummary> => {
  const env = resolveEnv()
  const pnpmAvailable =
    spawnSync(getPnpmCommand(), ['--version'], { stdio: 'ignore' }).status === 0
  const dockerAvailable =
    spawnSync(
      process.platform === 'win32' ? 'docker.exe' : 'docker',
      ['compose', 'version'],
      { stdio: 'ignore' },
    ).status === 0

  ensureDirectories()

  const config = createGeneratedConfig('no-docker', env)
  const postgresReady = canReachPostgresServer(config.database.url)

  return {
    config,
    dockerAvailable,
    env,
    paths,
    postgresReady,
    pnpmAvailable,
  }
}

const openBrowser = (url: string): void => {
  if (process.env.CI) {
    return
  }

  const commands: Array<[string, string[]]> =
    process.platform === 'darwin'
      ? [['open', [url]]]
      : process.platform === 'win32'
        ? [['cmd', ['/c', 'start', '', url]]]
        : [['xdg-open', [url]]]

  for (const [command, args] of commands) {
    const result = spawnSync(command, args, {
      stdio: 'ignore',
    })
    if (result.status === 0) {
      return
    }
  }
}

const printStatus = (state: LocalState): void => {
  console.log(`mode: ${state.mode}`)
  console.log(`started: ${state.startedAt}`)
  console.log(`api: ${state.apiUrl}`)
  console.log(`admin: ${state.adminUrl}`)

  for (const [service, entry] of Object.entries(state.services) as Array<
    [ServiceName, LocalState['services'][ServiceName]]
  >) {
    console.log(
      `${service}: ${isProcessAlive(entry.pid) ? 'running' : 'stopped'} ` +
      `(pid ${entry.pid}, log ${entry.logFile})`,
    )
  }
}

const downLocalStack = (
  state: LocalState | null,
  env: NodeJS.ProcessEnv,
  keepState = false,
): void => {
  if (state) {
    for (const service of Object.values(state.services)) {
      stopProcessGroup(service.pid)
    }
  }

  const mode = state?.mode
  if (mode === 'docker') {
    runDockerCompose(['down', '--remove-orphans'], env)
  }

  if (!keepState) {
    removeState()
  }
}

const pruneStaleState = (state: LocalState | null): LocalState | null => {
  if (!state) {
    return null
  }

  const statuses = Object.values(state.services).map((service) =>
    isProcessAlive(service.pid),
  )

  if (statuses.every(Boolean)) {
    return state
  }

  if (statuses.some(Boolean)) {
    downLocalStack(state, resolveEnv(), true)
  }

  removeState()
  return null
}

const tailLogFile = async (filePath: string, follow: boolean): Promise<void> => {
  if (!existsSync(filePath)) {
    throw new Error(`Log file not found: ${filePath}`)
  }

  const initialSize = statSync(filePath).size
  const startOffset = Math.max(0, initialSize - LOG_TAIL_BYTES)
  const initialContents = readFileSync(filePath, 'utf8').slice(startOffset)
  process.stdout.write(initialContents)

  if (!follow) {
    return
  }

  let offset = initialSize
  await new Promise<void>((resolvePromise) => {
    const watcher = watch(filePath, () => {
      const nextSize = statSync(filePath).size
      if (nextSize <= offset) {
        return
      }

      const contents = readFileSync(filePath, 'utf8')
      process.stdout.write(contents.slice(offset))
      offset = nextSize
    })

    const shutdown = () => {
      watcher.close()
      resolvePromise()
    }

    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  })
}

const upLocalStack = async (args: string[]): Promise<void> => {
  const doctor = await collectDoctorSummary()
  if (!doctor.pnpmAvailable) {
    throw new Error('pnpm is required to start the local stack.')
  }

  const mode = resolveLaunchMode(args, doctor.dockerAvailable)
  const env = resolveEnv()
  const existingState = pruneStaleState(readState())
  if (existingState) {
    printStatus(existingState)
    return
  }

  ensureDirectories()
  const config = createGeneratedConfig(mode, env)
  const capabilities = deriveRuntimeCapabilities(config)
  if (!capabilities.hasModelProvider) {
    throw new Error('Model API key is missing. Run `nessie local doctor` for guidance.')
  }

  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    DATABASE_URL: config.database.url,
    NESSIE_API_PORT: String(API_PORT),
    NESSIE_CONFIG_PATH: paths.configPath,
  }

  let dockerStarted = false

  try {
    if (mode === 'docker') {
      if (!doctor.dockerAvailable) {
        throw new Error('Docker Compose is not available.')
      }

      runDockerCompose(['up', '-d', 'postgres'], childEnv)
      dockerStarted = true
      await waitForTcpPort('127.0.0.1', DOCKER_POSTGRES_PORT)
      await waitForPostgresReady(DOCKER_DB_URL)
    } else {
      const { host, port } = parseDatabaseUrl(config.database.url)
      const postgresReachable = await canReachTcpPort(host, port)
      if (!postgresReachable) {
        throw new Error(
          `Postgres is not reachable at ${config.database.url}. ` +
          'Start Postgres or use `nessie local up --docker`.',
        )
      }

      ensureLocalDatabase(config.database.url)
    }

    runChecked(
      getPnpmCommand(),
      ['--filter', '@nessie/api', 'prisma:migrate:deploy'],
      { env: childEnv },
    )
  } catch (error) {
    if (dockerStarted) {
      runDockerCompose(['down', '--remove-orphans'], childEnv)
    }
    throw error
  }

  const services: LocalState['services'] = {
    admin: spawnDetachedService(
      'admin',
      paths.adminRoot,
      resolveLocalBin(paths.adminRoot, 'vite'),
      ['--host', LAN_BIND_HOST, '--port', String(ADMIN_PORT)],
      childEnv,
    ),
    api: spawnDetachedService(
      'api',
      paths.apiRoot,
      resolveLocalBin(repoRoot, 'tsx'),
      ['src/index.ts'],
      childEnv,
    ),
    worker: spawnDetachedService(
      'worker',
      paths.workerRoot,
      resolveLocalBin(repoRoot, 'tsx'),
      ['src/index.ts'],
      childEnv,
    ),
  }

  const state: LocalState = {
    adminUrl: `http://127.0.0.1:${ADMIN_PORT}`,
    apiUrl: `http://127.0.0.1:${API_PORT}`,
    composeFile: paths.composeFile,
    configPath: paths.configPath,
    databaseUrl: config.database.url,
    logsDir: paths.logsDir,
    mode,
    services,
    startedAt: new Date().toISOString(),
    stateDir: paths.stateDir,
    version: STATE_VERSION,
  }

  writeState(state)

  try {
    await waitForHttp(`${state.apiUrl}/api/auth/providers`)
    await waitForHttp(`${state.adminUrl}/login`)
    const workerReady = await waitForLogMatch(
      state.services.worker.logFile,
      /"status": "ready"/,
    )
    if (!workerReady) {
      throw new Error('Timed out waiting for worker readiness log entry.')
    }
  } catch (error) {
    downLocalStack(state, childEnv)
    throw error
  }

  console.log(`api: ${state.apiUrl}`)
  console.log(`admin: ${state.adminUrl}`)

  const bootstrapUrl = await waitForLogMatch(
    state.services.api.logFile,
    /http:\/\/[^\s]+\/admin\/bootstrap\?token=[^\s]+/,
    5_000,
  )
  if (bootstrapUrl) {
    console.log('bootstrap:')
    console.log(bootstrapUrl)
  }

  if (!args.includes('--no-open')) {
    openBrowser(state.adminUrl)
  }
}

const resetLocalData = async (args: string[]): Promise<void> => {
  if (!args.includes('--yes')) {
    throw new Error('Reset is destructive. Re-run with `nessie local reset --yes`.')
  }

  const env = resolveEnv()
  const state = readState()
  downLocalStack(state, env)

  const mode = state?.mode ?? 'no-docker'
  const config = createGeneratedConfig(mode, env)
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    DATABASE_URL: config.database.url,
    NESSIE_CONFIG_PATH: paths.configPath,
  }

  if (mode === 'no-docker') {
    runChecked(
      getPnpmCommand(),
      [
        '--filter',
        '@nessie/api',
        'exec',
        'prisma',
        'migrate',
        'reset',
        '--force',
        '--skip-generate',
        '--schema',
        'prisma/schema.prisma',
      ],
      { env: childEnv },
    )
  } else {
    runDockerCompose(['down', '--remove-orphans', '--volumes'], childEnv)
  }

  rmSync(paths.logsDir, { force: true, recursive: true })
  rmSync(paths.storageDir, { force: true, recursive: true })
  rmSync(paths.dockerDataDir, { force: true, recursive: true })
  rmSync(paths.configPath, { force: true })
  rmSync(paths.stateDir, { force: true, recursive: true })

  console.log('Local Nessie state reset.')
}

export const runLocalCommand = async (args: string[]): Promise<void> => {
  const [command, ...rest] = args

  switch (command) {
    case 'up':
      await upLocalStack(rest)
      return
    case 'down': {
      const env = resolveEnv()
      downLocalStack(readState(), env)
      console.log('Local Nessie stack stopped.')
      return
    }
    case 'status': {
      const state = readState()
      if (!state) {
        console.log('Local Nessie stack is stopped.')
        return
      }

      printStatus(state)
      return
    }
    case 'logs': {
      const state = readState()
      if (!state) {
        throw new Error('Local Nessie stack is not running.')
      }

      const service = (rest.find((arg) => !arg.startsWith('--')) ?? 'api') as
        | ServiceName
        | 'postgres'
      const follow = !rest.includes('--no-follow')

      if (service === 'postgres') {
        if (state.mode !== 'docker') {
          throw new Error('Postgres logs are only available when the local stack is running in docker mode.')
        }

        runDockerCompose(
          ['logs', ...(follow ? ['--follow'] : []), 'postgres'],
          resolveEnv(),
        )
        return
      }

      await tailLogFile(state.services[service].logFile, follow)
      return
    }
    case 'doctor':
      renderDoctor(await collectDoctorSummary())
      return
    case 'reset':
      await resetLocalData(rest)
      return
    default:
      throw new Error(`Unknown local command: ${command ?? '(missing)'}`)
  }
}
