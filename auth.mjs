import { createHash, randomBytes, scrypt as derive, scryptSync, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(derive)
const cost = { N: 32768, r: 8, p: 2, maxmem: 64 * 1024 * 1024 }
const sessionSeconds = 12 * 60 * 60
const digest = token => createHash('sha256').update(token).digest('hex')
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }) }
const usernameOf = input => typeof input === 'string' ? input.trim().toLowerCase() : ''
const validPassword = value => typeof value === 'string' && value.length >= 12 && value.length <= 128
const publicUser = user => ({ username: user.username, name: user.name, role: user.role, mustChangePassword: Boolean(user.must_change) })

function accountFields(value) {
  const username = usernameOf(value?.username)
  const name = typeof value?.name === 'string' ? value.name.trim() : ''
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) fail('Use 3–64 letters, digits, dots, underscores, or hyphens for the username.')
  if (!name || name.length > 100) fail('Enter a display name of up to 100 characters.')
  if (!validPassword(value?.password)) fail('Use a password of 12–128 characters.')
  return { username, name, password: value.password }
}

function credentials(password) {
  const salt = randomBytes(16).toString('hex')
  return [salt, scryptSync(password, salt, 64, cost).toString('hex')]
}

export function createAuth(db, { origin } = {}) {
  const lookup = (name, connection = db, lock = false) =>
    connection.one('SELECT * FROM users WHERE username=?' + (lock ? ' FOR UPDATE' : ''), [name])
  async function addAccount(value, role, mustChange) {
    const { username, name, password } = accountFields(value)
    try {
      const [salt, password_hash] = credentials(password)
      await db.user.create({ data: { username, name, role, salt, password_hash, must_change: mustChange } })
    } catch (error) {
      if (error.code === 'P2002') fail(role === 'admin' ? 'A super admin already exists or that username is taken.' : 'That username already exists.', 409)
      throw error
    }
    return { username, name, role, mustChangePassword: mustChange }
  }

  const secure = origin?.startsWith('https://')
  const cookieName = secure ? '__Host-trackline' : 'trackline'
  const cookie = (response, token, age) => response.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`)
  const sessionHash = request => {
    const token = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1)
    return /^[\w-]{43}$/.test(token || '') ? digest(token) : ''
  }
  const current = (request, connection = db) => connection.one('SELECT users.* FROM sessions JOIN users USING(username) WHERE sessions.hash=? AND expires>?', [sessionHash(request), Date.now()])
  const newSession = async (connection, username) => {
    const token = randomBytes(32).toString('base64url')
    await connection.execute('INSERT INTO sessions VALUES(?,?,?)', [digest(token), username, Date.now() + sessionSeconds * 1000])
    return token
  }
  let pending = 0
  const dummySalt = randomBytes(16).toString('hex')
  async function verify(user, password, address) {
    if (typeof password !== 'string' || !password.length || password.length > 128) return false
    if (pending >= 4) fail('Too many sign-in attempts. Try again in a few minutes.', 429)
    pending++
    try {
      const bucket = Math.floor(Date.now() / 300000)
      const keys = [['ip:' + digest(address || ''), 75]]
      if (user) keys.push(['user:' + user.username, 12])
      await db.transaction(async connection => {
        for (const [key, limit] of keys) {
          await connection.execute('INSERT INTO login_attempts VALUES(?,?,1) ON DUPLICATE KEY UPDATE attempts=attempts+1', [key, bucket])
          const row = await connection.one('SELECT attempts FROM login_attempts WHERE attempt_key=? AND bucket=?', [key, bucket])
          if (row.attempts > limit) fail('Too many sign-in attempts. Try again in a few minutes.', 429)
        }
      })
      const candidate = await scrypt(password, user?.salt || dummySalt, 64, cost)
      const valid = timingSafeEqual(candidate, Buffer.from(user?.password_hash || '0'.repeat(128), 'hex')) && !!user
      if (valid) {
        await db.execute('DELETE FROM login_attempts WHERE bucket < ? LIMIT 200', [bucket - 1])
        await db.execute('DELETE FROM sessions WHERE expires <= ? LIMIT 200', [Date.now()])
      }
      return valid
    } finally { pending-- }
  }

  return {
    current,
    initializeAdmin: (value, mustChange = Boolean(value?.mustChange)) => addAccount(value, 'admin', mustChange),
    hasAdmin: async () => !!await db.one("SELECT 1 FROM users WHERE role='admin'"),
    members: async () => (await db.query('SELECT name FROM users ORDER BY name')).map(user => user.name),
    sameOrigin(request) {
      const source = request.headers.origin
      if (!source || request.headers['sec-fetch-site'] === 'cross-site') return false
      if (origin) return source === origin
      const host = request.headers.host || ''
      return /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host) && source === 'http://' + host
    },
    async login(request, response, value) {
      const user = await lookup(usernameOf(value?.username).slice(0, 65))
      if (!await verify(user, value?.password, request.socket.remoteAddress)) fail('Incorrect username or password.', 401)
      const token = await db.transaction(async connection => {
        if ((await lookup(user.username, connection, true))?.password_hash !== user.password_hash) fail('Incorrect username or password.', 401)
        await connection.execute('DELETE FROM sessions WHERE hash=?', [sessionHash(request)])
        return newSession(connection, user.username)
      })
      cookie(response, token, sessionSeconds)
      return publicUser(user)
    },
    async logout(request, response) {
      await db.execute('DELETE FROM sessions WHERE hash=?', [sessionHash(request)])
      cookie(response, '', 0)
    },
    async changePassword(request, response, user, value) {
      if (!validPassword(value?.password)) fail('Use a password of 12–128 characters.')
      if (value.password === value.currentPassword) fail('Choose a different password.')
      if (!await verify(user, value.currentPassword, request.socket.remoteAddress)) fail('The current password is incorrect.')
      const updated = credentials(value.password)
      const token = await db.transaction(async connection => {
        await lookup(user.username, connection, true)
        if ((await current(request, connection))?.password_hash !== user.password_hash) fail('The account changed. Sign in again.', 401)
        await connection.execute('UPDATE users SET salt=?,password_hash=?,must_change=0 WHERE username=?', [...updated, user.username])
        await connection.execute('DELETE FROM sessions WHERE username=?', [user.username])
        return newSession(connection, user.username)
      })
      cookie(response, token, sessionSeconds)
      return publicUser({ ...user, must_change: 0 })
    },
    profile: publicUser,
    list: async () => (await db.query('SELECT username,name,role,must_change FROM users ORDER BY role, name')).map(publicUser),
    add: value => addAccount(value, 'member', true),
    async reset(username, password) {
      const member = await lookup(usernameOf(username))
      if (!member || member.role !== 'member') fail('Team member not found.', 404)
      if (!validPassword(password)) fail('Use a temporary password of 12–128 characters.')
      const updated = credentials(password)
      await db.transaction(async connection => {
        await connection.execute('UPDATE users SET salt=?,password_hash=?,must_change=1 WHERE username=?', [...updated, member.username])
        await connection.execute('DELETE FROM sessions WHERE username=?', [member.username])
      })
    },
  }
}
