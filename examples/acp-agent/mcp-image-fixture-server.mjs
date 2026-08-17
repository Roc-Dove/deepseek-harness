import { createInterface } from 'node:readline'

const IMAGE_DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    error(null, -32700, 'Parse error')
    return
  }

  if (message.id === undefined) return
  switch (message.method) {
    case 'initialize':
      result(message.id, {
        protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'snapshot-image-fixture', version: '1.0.0' },
      })
      return
    case 'ping':
      result(message.id, {})
      return
    case 'tools/list':
      result(message.id, {
        tools: [{
          name: 'render_chart',
          description: 'Return a deterministic chart image between two text blocks.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        }],
      })
      return
    case 'tools/call':
      if (message.params?.name !== 'render_chart') {
        error(message.id, -32601, 'Unknown tool')
        return
      }
      result(message.id, {
        content: [
          { type: 'text', text: 'chart-before' },
          { type: 'image', data: IMAGE_DATA, mimeType: 'image/png' },
          { type: 'text', text: 'chart-after' },
        ],
      })
      return
    default:
      error(message.id, -32601, 'Method not found')
  }
})
