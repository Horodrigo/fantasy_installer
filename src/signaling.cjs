const { createServer } = require('node:http')
const { randomUUID, webcrypto } = require('node:crypto')
const { WebSocketServer } = require('ws')

function randomToken(prefix) {
  const bytes = new Uint8Array(18)
  webcrypto.getRandomValues(bytes)
  return `${prefix}_${Buffer.from(bytes).toString('base64url')}`
}

function send(socket, payload) {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(payload))
  }
}

function getCountryFromRequest(req) {
  const country = req.headers['cf-ipcountry']
  if (typeof country === 'string' && country.length > 1) {
    return country
  }
  return 'Desconhecido'
}

async function verifySignature(publicKeyJwk, challengeB64, signatureB64) {
  const publicKey = await webcrypto.subtle.importKey(
    'jwk',
    publicKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  )
  return webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    publicKey,
    Buffer.from(signatureB64, 'base64url'),
    Buffer.from(challengeB64, 'base64url'),
  )
}

function startSignalingServer(port) {
  const rooms = new Map()
  const clients = new Map()

  function ensureRoom(bookId) {
    if (!rooms.has(bookId)) {
      rooms.set(bookId, {
        bookId,
        inviteToken: randomToken('invite'),
        hostSecret: null,
        hostClientId: null,
        pending: new Map(),
        acl: new Map(),
        players: new Map(),
        state: null,
      })
    }
    return rooms.get(bookId)
  }

  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    res.writeHead(404)
    res.end('Not found')
  })

  const wss = new WebSocketServer({ server })

  wss.on('connection', (socket, req) => {
    const clientId = randomUUID()
    clients.set(clientId, { socket, role: null, bookId: null })
    send(socket, { type: 'server:connected', clientId })

    socket.on('message', async (raw) => {
      let payload
      try {
        payload = JSON.parse(raw.toString())
      } catch {
        send(socket, { type: 'server:error', message: 'Payload JSON inválido.' })
        return
      }

      const client = clients.get(clientId)
      if (!client) {
        return
      }

      if (payload.type === 'narrator:open-room') {
        const room = ensureRoom(payload.bookId)
        room.hostClientId = clientId
        room.hostSecret = payload.hostSecret
        room.inviteToken = payload.inviteToken || room.inviteToken
        client.role = 'narrator'
        client.bookId = payload.bookId
        send(socket, {
          type: 'room:opened',
          clientId,
          bookId: room.bookId,
          inviteToken: room.inviteToken,
          pending: [...room.pending.values()],
          acl: [...room.acl.values()],
        })
        return
      }

      if (payload.type === 'narrator:rotate-invite') {
        const room = ensureRoom(payload.bookId)
        if (room.hostClientId !== clientId || room.hostSecret !== payload.hostSecret) {
          send(socket, { type: 'server:error', message: 'Host inválido para rotacionar convite.' })
          return
        }
        room.inviteToken = payload.inviteToken || randomToken('invite')
        send(socket, { type: 'room:invite-rotated', inviteToken: room.inviteToken })
        return
      }

      if (payload.type === 'player:join-request') {
        const room = [...rooms.values()].find((candidate) => candidate.inviteToken === payload.inviteToken)
        if (!room) {
          send(socket, { type: 'room:rejected', reason: 'Invite inválido ou expirado.' })
          return
        }
        client.role = 'player'
        client.bookId = room.bookId

        const challengeBytes = new Uint8Array(24)
        webcrypto.getRandomValues(challengeBytes)
        const pendingId = randomToken('pending')
        const pending = {
          id: pendingId,
          clientId,
          bookId: room.bookId,
          displayName: payload.displayName,
          fingerprint: payload.fingerprint,
          publicKeyJwk: payload.publicKeyJwk,
          country: getCountryFromRequest(req),
          challenge: Buffer.from(challengeBytes).toString('base64url'),
          createdAt: Date.now(),
        }
        room.pending.set(pendingId, pending)
        if (room.hostClientId && clients.get(room.hostClientId)) {
          send(clients.get(room.hostClientId).socket, { type: 'room:pending-join', pending })
        } else {
          send(socket, { type: 'room:waiting-host', message: 'Aguardando narrador abrir a sala.' })
        }
        return
      }

      if (payload.type === 'narrator:approve-player') {
        const room = ensureRoom(payload.bookId)
        if (room.hostClientId !== clientId || room.hostSecret !== payload.hostSecret) {
          send(socket, { type: 'server:error', message: 'Host inválido.' })
          return
        }
        const pending = room.pending.get(payload.pendingId)
        if (!pending) {
          return
        }
        room.acl.set(pending.fingerprint, {
          displayName: pending.displayName,
          fingerprint: pending.fingerprint,
          publicKeyJwk: pending.publicKeyJwk,
          country: pending.country,
          approvedAt: Date.now(),
          revokedAt: null,
        })
        send(clients.get(pending.clientId).socket, {
          type: 'room:challenge',
          bookId: room.bookId,
          pendingId: pending.id,
          challenge: pending.challenge,
        })
        send(socket, { type: 'room:acl-updated', acl: [...room.acl.values()] })
        return
      }

      if (payload.type === 'narrator:reject-player') {
        const room = ensureRoom(payload.bookId)
        if (room.hostClientId !== clientId || room.hostSecret !== payload.hostSecret) {
          send(socket, { type: 'server:error', message: 'Host inválido.' })
          return
        }
        const pending = room.pending.get(payload.pendingId)
        if (!pending) {
          return
        }
        room.pending.delete(payload.pendingId)
        send(clients.get(pending.clientId).socket, {
          type: 'room:rejected',
          reason: 'Entrada recusada pelo narrador.',
        })
        return
      }

      if (payload.type === 'player:challenge-response') {
        const room = ensureRoom(payload.bookId)
        const pending = room.pending.get(payload.pendingId)
        if (!pending || pending.clientId !== clientId) {
          send(socket, { type: 'room:rejected', reason: 'Desafio inválido.' })
          return
        }
        const verified = await verifySignature(pending.publicKeyJwk, pending.challenge, payload.signature)
        room.pending.delete(payload.pendingId)
        if (!verified) {
          send(socket, { type: 'room:rejected', reason: 'Falha na autenticação criptográfica.' })
          return
        }
        room.players.set(clientId, {
          clientId,
          displayName: pending.displayName,
          fingerprint: pending.fingerprint,
        })
        send(socket, { type: 'room:approved', clientId, bookId: room.bookId, state: room.state })
        return
      }

      if (payload.type === 'narrator:revoke-player') {
        const room = ensureRoom(payload.bookId)
        if (room.hostClientId !== clientId || room.hostSecret !== payload.hostSecret) {
          send(socket, { type: 'server:error', message: 'Host inválido.' })
          return
        }
        const acl = room.acl.get(payload.fingerprint)
        if (!acl) {
          return
        }
        acl.revokedAt = Date.now()
        room.acl.set(payload.fingerprint, acl)
        for (const [playerClientId, player] of room.players.entries()) {
          if (player.fingerprint === payload.fingerprint) {
            send(clients.get(playerClientId).socket, {
              type: 'room:revoked',
              reason: 'Acesso revogado pelo narrador.',
            })
            room.players.delete(playerClientId)
          }
        }
        send(socket, { type: 'room:acl-updated', acl: [...room.acl.values()] })
        return
      }

      if (payload.type === 'narrator:state-update') {
        const room = ensureRoom(payload.bookId)
        if (room.hostClientId !== clientId || room.hostSecret !== payload.hostSecret) {
          send(socket, { type: 'server:error', message: 'Host inválido para sincronização.' })
          return
        }
        room.state = payload.state
        for (const playerClientId of room.players.keys()) {
          send(clients.get(playerClientId).socket, { type: 'room:state', state: room.state })
        }
      }
    })

    socket.on('close', () => {
      const client = clients.get(clientId)
      if (!client) {
        return
      }
      if (client.role === 'narrator' && client.bookId && rooms.has(client.bookId)) {
        rooms.get(client.bookId).hostClientId = null
      }
      if (client.role === 'player' && client.bookId && rooms.has(client.bookId)) {
        rooms.get(client.bookId).players.delete(clientId)
      }
      clients.delete(clientId)
    })
  })

  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      reject(error)
    })
    server.listen(port, '127.0.0.1', () => {
      resolve({
        close: () => {
          wss.close()
          server.close()
        },
      })
    })
  })
}

module.exports = { startSignalingServer }
