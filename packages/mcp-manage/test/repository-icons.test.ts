import assert from 'node:assert/strict'
import test from 'node:test'

import type { StoreFileInput } from '@nessie/runtime'

import {
  cacheRepositoryIcon,
  REPOSITORY_ICON_SOURCE,
  sniffImageMime,
  type IconFetch,
  type IconFileService,
} from '../src/index.js'

const figmaSvg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#000" d="M0 0h24v24H0z"/></svg>',
)

const responseOf = (bytes: Buffer, ok = true): Response =>
  ({
    ok,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes))
        controller.close()
      },
    }),
    headers: { get: () => null },
  }) as unknown as Response

const recordingFileService = () => {
  const calls: StoreFileInput[] = []
  const fileService: IconFileService = {
    store: async (input) => {
      calls.push(input)
      return { attachment: { id: 'repository-icon' } }
    },
  }
  return { calls, fileService }
}

const figmaDescriptor = (path = './Figma Icon.svg') => Buffer.from(JSON.stringify({
  mcpServers: {
    figma: {
      type: 'http',
      url: 'https://mcp.figma.com/mcp',
      _meta: { ideToolIconPath: path },
    },
  },
}))

test('resolves an IDE icon path from the same GitHub repository and stores a raster derivative', async () => {
  const { calls, fileService } = recordingFileService()
  const urls: string[] = []
  const fetch: IconFetch = async (url) => {
    urls.push(url)
    if (url === 'https://api.github.com/repos/figma/mcp-server-guide') {
      return responseOf(Buffer.from(JSON.stringify({ default_branch: 'main' })))
    }
    if (url.endsWith('/.mcp.json')) return responseOf(figmaDescriptor())
    if (url.endsWith('/Figma%20Icon.svg')) return responseOf(figmaSvg)
    throw new Error(`unexpected fetch: ${url}`)
  }

  const result = await cacheRepositoryIcon({
    actorId: 'actor-1',
    displayName: 'Figma MCP Server',
    endpointUrl: 'https://mcp.figma.com/mcp',
    fetch,
    fileService,
    organizationId: 'org-1',
    repositoryUrl: 'https://github.com/figma/mcp-server-guide',
  })

  assert.deepEqual(result, { attachmentId: 'repository-icon', source: REPOSITORY_ICON_SOURCE })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.mime, 'image/webp')
  assert.equal(calls[0]?.filename, 'figma-mcp-server-icon.webp')
  const chunks: Buffer[] = []
  for await (const chunk of calls[0]!.body) chunks.push(Buffer.from(chunk))
  assert.equal(sniffImageMime(Buffer.concat(chunks)), 'image/webp')
  assert.equal(urls.length, 3)
})

test('refuses a repository path escape before fetching any asset', async () => {
  const { calls, fileService } = recordingFileService()
  const urls: string[] = []
  const fetch: IconFetch = async (url) => {
    urls.push(url)
    if (url === 'https://api.github.com/repos/figma/mcp-server-guide') {
      return responseOf(Buffer.from(JSON.stringify({ default_branch: 'main' })))
    }
    if (url.endsWith('/.mcp.json')) return responseOf(figmaDescriptor('../outside.svg'))
    throw new Error(`asset must not be fetched: ${url}`)
  }

  const result = await cacheRepositoryIcon({
    actorId: 'actor-1',
    displayName: 'Figma MCP Server',
    endpointUrl: 'https://mcp.figma.com/mcp',
    fetch,
    fileService,
    organizationId: 'org-1',
    repositoryUrl: 'https://github.com/figma/mcp-server-guide',
  })

  assert.equal(result, null)
  assert.equal(calls.length, 0)
  assert.equal(urls.length, 2)
})

test('does not take an icon from a different server in the same descriptor', async () => {
  const { calls, fileService } = recordingFileService()
  const urls: string[] = []
  const fetch: IconFetch = async (url) => {
    urls.push(url)
    if (url === 'https://api.github.com/repos/figma/mcp-server-guide') {
      return responseOf(Buffer.from(JSON.stringify({ default_branch: 'main' })))
    }
    if (url.endsWith('/.mcp.json')) return responseOf(Buffer.from(JSON.stringify({
      mcpServers: { another: { url: 'https://different.example/mcp', _meta: { ideToolIconPath: './wrong.svg' } } },
    })))
    throw new Error(`asset must not be fetched: ${url}`)
  }

  const result = await cacheRepositoryIcon({
    actorId: 'actor-1',
    displayName: 'Figma MCP Server',
    endpointUrl: 'https://mcp.figma.com/mcp',
    fetch,
    fileService,
    organizationId: 'org-1',
    repositoryUrl: 'https://github.com/figma/mcp-server-guide',
  })

  assert.equal(result, null)
  assert.equal(calls.length, 0)
  assert.equal(urls.length, 2)
})
