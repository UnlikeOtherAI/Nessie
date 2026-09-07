import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'

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
  let received = ''
  let failure
  socket.on('data', (chunk) => {
    received += chunk
    pending += chunk
    for (;;) {
      const boundary = pending.indexOf('\r\n')
      if (boundary < 0) return
      lines.push(pending.slice(0, boundary))
      pending = pending.slice(boundary + 2)
    }
  })
  socket.on('error', (error) => { failure = error })
  socket.on('close', () => {
    failure ??= new Error('The local mail server closed the socket unexpectedly.')
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
      if (failure) throw failure
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${pattern}.`)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  return { raw: () => received, waitFor }
}

const smtpSend = async (marker) => {
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
      + `Message-ID: <${marker}@nessie.test>\r\n`
      + `Subject: Nessie local mail E2E ${marker}\r\n`
      + '\r\n'
      + `SMTP delivery verified: ${marker}.\r\n.\r\n`,
    )
    await wire.waitFor(/^250 OK/)
    socket.write('QUIT\r\n')
    await wire.waitFor(/^221/)
  } finally {
    socket.destroy()
  }
}

const imapReceive = async (marker) => {
  const socket = await open(IMAP_PORT)
  const wire = transcript(socket)
  try {
    await wire.waitFor(/^\* OK/)
    socket.write(`a1 LOGIN "recipient" "${PASSWORD}"\r\n`)
    await wire.waitFor(/^a1 OK/)
    socket.write('a2 SELECT INBOX\r\n')
    await wire.waitFor(/^a2 OK/)
    socket.write(`a3 UID SEARCH HEADER MESSAGE-ID "<${marker}@nessie.test>"\r\n`)
    const search = await wire.waitFor(/^\* SEARCH /)
    await wire.waitFor(/^a3 OK/)
    const uid = Number(/^\* SEARCH\s+(\d+)\s*$/.exec(search)?.[1])
    if (!Number.isSafeInteger(uid) || uid < 1) {
      throw new Error('SMTP-delivered message was absent from recipient IMAP search results.')
    }
    const beforeFetch = wire.raw().length
    socket.write(`a4 UID FETCH ${uid} BODY[]\r\n`)
    await wire.waitFor(/^a4 OK/)
    if (!wire.raw().slice(beforeFetch).includes(`SMTP delivery verified: ${marker}.`)) {
      throw new Error('IMAP did not return the exact body delivered over SMTP.')
    }
    socket.write('a5 LOGOUT\r\n')
    await wire.waitFor(/^a5 OK/)
  } finally {
    socket.destroy()
  }
}

const marker = randomUUID()
await smtpSend(marker)
await imapReceive(marker)
console.log('Local SMTP-to-IMAP delivery passed.')
