import { connect } from 'node:net'

const SMTP_PORT = 3025
const IMAP_PORT = 3143
const PASSWORD = 'mail-e2e-only'

const open = (port) => new Promise((resolve, reject) => {
  const socket = connect({ host: '127.0.0.1', port })
  socket.setEncoding('utf8')
  socket.once('connect', () => resolve(socket))
  socket.once('error', reject)
})

const transcript = (socket) => {
  const lines = []
  let pending = ''
  socket.on('data', (chunk) => {
    pending += chunk
    for (;;) {
      const boundary = pending.indexOf('\r\n')
      if (boundary < 0) return
      lines.push(pending.slice(0, boundary))
      pending = pending.slice(boundary + 2)
    }
  })

  let cursor = 0
  const waitFor = async (pattern) => {
    const deadline = Date.now() + 2_000
    for (;;) {
      for (let index = cursor; index < lines.length; index += 1) {
        if (!pattern.test(lines[index])) continue
        cursor = index + 1
        return lines[index]
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${pattern}.`)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  return { waitFor }
}

const smtpSend = async () => {
  const socket = await open(SMTP_PORT)
  const wire = transcript(socket)
  try {
    await wire.waitFor(/^220/)
    socket.write('EHLO localhost\r\n')
    await wire.waitFor(/^250 /)
    socket.write(`AUTH PLAIN ${Buffer.from(`\0agent\0${PASSWORD}`).toString('base64')}\r\n`)
    await wire.waitFor(/^235/)
    socket.write('MAIL FROM:<agent@nessie.test>\r\n')
    await wire.waitFor(/^250 OK/)
    socket.write('RCPT TO:<recipient@nessie.test>\r\n')
    await wire.waitFor(/^250 OK/)
    socket.write('DATA\r\n')
    await wire.waitFor(/^354/)
    socket.write(
      'From: agent@nessie.test\r\n'
      + 'To: recipient@nessie.test\r\n'
      + 'Subject: Nessie local mail E2E\r\n'
      + '\r\n'
      + 'SMTP delivery verified.\r\n.\r\n',
    )
    await wire.waitFor(/^250 OK/)
    socket.write('QUIT\r\n')
    await wire.waitFor(/^221/)
  } finally {
    socket.destroy()
  }
}

const imapReceive = async () => {
  const socket = await open(IMAP_PORT)
  const wire = transcript(socket)
  try {
    await wire.waitFor(/^\* OK/)
    socket.write(`a1 LOGIN "recipient" "${PASSWORD}"\r\n`)
    await wire.waitFor(/^a1 OK/)
    socket.write('a2 SELECT INBOX\r\n')
    const deadline = Date.now() + 2_000
    let exists = false
    while (Date.now() < deadline) {
      try {
        await wire.waitFor(/^\* [1-9]\d* EXISTS/)
        exists = true
        break
      } catch {
        break
      }
    }
    await wire.waitFor(/^a2 OK/)
    if (!exists) throw new Error('SMTP-delivered message was absent from recipient INBOX.')
    socket.write('a3 LOGOUT\r\n')
    await wire.waitFor(/^a3 OK/)
  } finally {
    socket.destroy()
  }
}

await smtpSend()
await imapReceive()
console.log('Local SMTP-to-IMAP delivery passed.')
