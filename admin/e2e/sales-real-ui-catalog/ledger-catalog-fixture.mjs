import http from 'node:http'

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'mock-model', kind: 'service', display_name: 'Mock chat model', service: { id: 'mock-llm', name: 'Mock LLM' }, endpoints: ['chat/completions'] }] }))
    return
  }
  response.writeHead(404).end()
})
server.listen(5457, '127.0.0.1')
