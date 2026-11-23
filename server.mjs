import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createAuth } from './auth.mjs'
import { connectDatabase, mysqlConfig } from './database.mjs'

const statuses = ['To do', 'In progress', 'Blocked', 'In review', 'Done']
const types = ['Feature', 'Bug', 'Fix', 'Task']
const priorities = ['Low', 'Medium', 'High', 'Urgent']
const columns = ['title', 'type', 'project', 'owner', 'status', 'priority', 'due', 'description', 'resolution', 'team']
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/styles.css', ['styles.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/csv.js', ['csv.js', 'text/javascript']],
])

function bad(message, status = 400) {
  throw Object.assign(new Error(message), { status })
}

function field(value, max = 10000) {
  if (value == null) return ''
  if (typeof value !== 'string' || value.length > max) bad(`Expected text of at most ${max} characters.`)
  return value.trim()
}

function itemFields(value) {
  if (!value || typeof value !== 'object') bad('Expected a work item.')
  const item = Object.fromEntries(columns.map(key => [key, field(value[key], ['description', 'resolution'].includes(key) ? 10000 : 180)]))
  if (item.team.length > 100) bad('Use a team name of up to 100 characters.')
  if (!item.title || !item.project) bad('Title and project are required.')
  item.type ||= 'Task'
  item.priority ||= 'Medium'
  item.status ||= 'To do'
  if (!types.includes(item.type) || !priorities.includes(item.priority) || !statuses.includes(item.status)) bad('Unknown type, priority, or status.')
  if (item.due && (!/^\d{4}-\d{2}-\d{2}$/.test(item.due) || Number.isNaN(Date.parse(item.due)) || new Date(item.due).toISOString().slice(0, 10) !== item.due)) bad('Enter a valid due date in YYYY-MM-DD format.')
  if (item.status === 'Done' && !item.resolution) bad('Add a resolution before marking this item done.')
  return item
}

const allowedMimeTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml']
const uploadIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i

async function resolveImages(connection, input, username) {
  if (!Array.isArray(input)) return parseImages(input)
  if (input.length > 10) bad('You can include at most 10 images at a time.')
  const resolved = []
  for (const image of input) {
    if (!image?.uploadId) { resolved.push(image); continue }
    if (!uploadIdPattern.test(image.uploadId)) bad('Invalid image upload.')
    const parts = await connection.query('SELECT part,data FROM image_uploads WHERE upload_id=? AND username=? AND expires>? ORDER BY part FOR UPDATE',
      [image.uploadId, username, Date.now()])
    if (!Number.isInteger(image.parts) || image.parts < 1 || image.parts > 26 ||
      parts.length !== image.parts || parts.some((part, index) => part.part !== index)) {
      bad('An image upload is incomplete or expired. Attach the image again.')
    }
    resolved.push({ ...image, data: parts.map(part => part.data).join('') })
    await connection.execute('DELETE FROM image_uploads WHERE upload_id=? AND username=?', [image.uploadId, username])
  }
  return parseImages(resolved)
}

function parseImages(input) {
  if (!input) return []
  if (!Array.isArray(input)) bad('Images must be provided as a list.')
  if (input.length > 10) bad('You can include at most 10 images at a time.')
  return input.map((img, i) => {
    if (!img || typeof img !== 'object') bad(`Invalid image at index ${i + 1}.`)
    const filename = field(img.filename || `image-${i + 1}.png`, 255)
    const mimeType = (typeof img.mimeType === 'string' ? img.mimeType.toLowerCase().trim() : '') || 'image/png'
    if (!allowedMimeTypes.includes(mimeType)) bad(`Unsupported image format for ${filename}. Use PNG, JPEG, WebP, GIF, or SVG.`)
    let dataStr = typeof img.data === 'string' ? img.data : ''
    if (dataStr.includes(',')) dataStr = dataStr.split(',')[1]
    const buffer = Buffer.from(dataStr, 'base64')
    if (!buffer.length) bad(`Image data missing for ${filename}.`)
    if (buffer.length > 10_000_000) bad(`Image ${filename} exceeds the 10 MB limit.`)
    return {
      filename,
      mime_type: mimeType,
      size: buffer.length,
      data: buffer,
    }
  })
}

async function saveImages(connection, itemId, images, at) {
  for (const img of images) {
    await connection.itemImage.create({
      data: {
        item_id: itemId,
        filename: img.filename,
        mime_type: img.mime_type,
        size: img.size,
        data: img.data,
        created: at,
      },
    })
  }
}

async function readJSON(request) {
  const limit = 25_000_000
  if (Number(request.headers['content-length']) > limit) bad('Request exceeds 25 MB.', 413)
  let size = 0
  const chunks = []
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > limit) bad('Request exceeds 25 MB.', 413)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks)) } catch { bad('Invalid JSON.') }
}

export async function readTicket(db, id) {
  // A single statement gives the ticket, timeline and attachment metadata one snapshot.
  const ticket = await db.one(`
    SELECT items.*,
      (SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
        'id', events.id, 'item_id', events.item_id, 'kind', events.kind,
        'actor', events.actor, 'body', events.body, 'minutes', events.minutes, 'at', events.at
      )), JSON_ARRAY()) FROM events WHERE events.item_id=items.id) AS events,
      (SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
        'id', item_images.id, 'item_id', item_images.item_id, 'filename', item_images.filename,
        'mime_type', item_images.mime_type, 'size', item_images.size, 'created', item_images.created
      )), JSON_ARRAY()) FROM item_images WHERE item_images.item_id=items.id) AS images,
      (SELECT COALESCE(JSON_ARRAYAGG(depends_on_id), JSON_ARRAY())
        FROM item_dependencies WHERE item_id=items.id) AS dependencyIds,
      (SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
        'id', child.id, 'parent_id', child.parent_id, 'title', child.title,
        'project', child.project, 'owner', child.owner, 'team', child.team,
        'status', child.status, 'priority', child.priority, 'due', child.due,
        'version', child.version, 'updated', child.updated,
        'dependencyIds', (SELECT COALESCE(JSON_ARRAYAGG(depends_on_id), JSON_ARRAY())
          FROM item_dependencies WHERE item_id=child.id)
      )), JSON_ARRAY()) FROM items child WHERE child.parent_id=items.id) AS subtasks
    FROM items WHERE items.id=?`, [id])
  if (!ticket) bad('Work item not found.', 404)
  for (const key of ['events', 'images', 'dependencyIds', 'subtasks']) {
    if (typeof ticket[key] === 'string') ticket[key] = JSON.parse(ticket[key])
    ticket[key] ||= []
  }
  ticket.events.sort((left, right) => right.id - left.id)
  ticket.images.sort((left, right) => left.id - right.id)
  ticket.subtasks.sort((left, right) => left.id - right.id)
  ticket.dependencyIds.sort((left, right) => left - right)
  return ticket
}

export function createRequestHandler(db, { origin } = {}) {
  const now = () => new Date().toISOString()
  const requireProject = async (connection, name) =>
    (await connection.one('SELECT name FROM projects WHERE name=?', [name]))?.name ??
      bad('Select an existing project. Ask your super admin to create it if needed.')
  const log = (connection, id, kind, actor, body, minutes = 0, at = now()) =>
    connection.execute('INSERT INTO events(item_id,kind,actor,body,minutes,at) VALUES(?,?,?,?,?,?)', [id, kind, actor, body, minutes, at])
  const add = async (connection, item, actor, kind = 'Created', at = now()) => {
    const { id } = await connection.item.create({ data: { ...item, created: at, updated: at }, select: { id: true } })
    await log(connection, id, kind, actor, kind === 'Imported' ? 'Imported from CSV' : 'Created this work item', 0, at)
    return id
  }
  const get = async (connection, id, lock = false) =>
    (await connection.one('SELECT * FROM items WHERE id=?' + (lock ? ' FOR UPDATE' : ''), [id])) ?? bad('Work item not found.', 404)
  const detail = (connection, id) => readTicket(connection, id)
  const dependencyIds = value => {
    if (!Array.isArray(value) || value.length > 100 ||
      value.some(id => !Number.isSafeInteger(id) || id < 1 || id > 4294967295)) bad('Choose valid subtask dependencies.')
    return [...new Set(value)].sort((left, right) => left - right)
  }
  const saveDependencies = async (connection, id, parentId, input) => {
    const ids = dependencyIds(input)
    if (!parentId && ids.length) bad('Dependencies can be linked between subtasks inside the same item.')
    if (ids.includes(id)) bad('A subtask cannot depend on itself.')
    const siblings = parentId ? await connection.query('SELECT id FROM items WHERE parent_id=? FOR UPDATE', [parentId]) : []
    if (ids.some(dependency => !siblings.some(sibling => sibling.id === dependency))) {
      bad('Choose dependencies from subtasks inside this item.')
    }
    const edges = parentId ? await connection.query('SELECT item_id,depends_on_id FROM item_dependencies JOIN items ON items.id=item_id WHERE items.parent_id=? FOR UPDATE', [parentId]) : []
    const current = edges.filter(edge => edge.item_id === id).map(edge => edge.depends_on_id).sort((a, b) => a - b)
    if (JSON.stringify(current) === JSON.stringify(ids)) return false
    const graph = new Map(siblings.map(sibling => [sibling.id, []]))
    for (const edge of edges) if (edge.item_id !== id) graph.get(edge.item_id)?.push(edge.depends_on_id)
    const queue = [...ids]
    const visited = new Set()
    while (queue.length) {
      const next = queue.pop()
      if (next === id) bad('These dependencies would create a cycle.')
      if (visited.has(next)) continue
      visited.add(next)
      queue.push(...(graph.get(next) || []))
    }
    await connection.execute('DELETE FROM item_dependencies WHERE item_id=?', [id])
    if (ids.length) await connection.execute('INSERT INTO item_dependencies(item_id,depends_on_id) VALUES ' + ids.map(() => '(?,?)').join(','), ids.flatMap(dependency => [id, dependency]))
    return true
  }
  const auth = createAuth(db, { origin })
  return async (request, response) => {
    const send = (status, data) => {
      const body = JSON.stringify(data)
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      response.end(body)
    }
    try {
      response.setHeader('X-Content-Type-Options', 'nosniff')
      response.setHeader('Referrer-Policy', 'same-origin')
      response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; object-src 'none'; frame-ancestors 'none'; base-uri 'none'")
      const url = new URL(request.url, 'http://localhost')
      const { pathname } = url
      const method = request.method
      if (method === 'GET' && assets.has(pathname)) {
        const [file, type] = assets.get(pathname)
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' })
        return response.end(readFileSync(new URL(`./public/${file}`, import.meta.url)))
      }
      if (method !== 'GET' && (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '') ||
        !auth.sameOrigin(request))) bad('A same-origin JSON request is required.', 415)
      const value = method === 'GET' ? undefined : await readJSON(request)
      if (method === 'GET' && pathname === '/api/health') {
        try {
          await db.one('SELECT 1')
          return send(200, { status: 'healthy', database: 'connected' })
        } catch (dbError) {
          return send(500, { status: 'error', database: 'unreachable', message: dbError.message || dbError.code })
        }
      }
      if (method === 'POST' && pathname === '/api/session') return send(200, await auth.login(request, response, value))
      if (method === 'DELETE' && pathname === '/api/session') {
        await auth.logout(request, response)
        return send(200, {})
      }
      const user = await auth.current(request)
      if (!user) bad('Sign in with your Trackline account.', 401)
      const imageMatch = /^\/api\/images\/(\d+)$/.exec(pathname)
      if (method === 'GET' && imageMatch) {
        const imageId = Number(imageMatch[1])
        const img = await db.itemImage.findUnique({
          where: { id: imageId },
          select: { filename: true, mime_type: true, size: true, data: true },
        })
        if (!img) bad('Image not found.', 404)
        if (url.searchParams.has('part')) {
          const part = Number(url.searchParams.get('part'))
          const parts = Math.ceil(img.size / 524288)
          if (!Number.isInteger(part) || part < 0 || part >= parts) bad('Invalid image part.')
          return send(200, { data: Buffer.from(img.data).subarray(part * 524288, (part + 1) * 524288).toString('base64') })
        }
        response.writeHead(200, {
          'Content-Type': img.mime_type,
          'Content-Length': img.size,
          'Cache-Control': 'private, max-age=86400',
          'Content-Disposition': `inline; filename="${encodeURIComponent(img.filename)}"`,
        })
        return response.end(img.data)
      }
      if (method === 'GET' && pathname === '/api/session') return send(200, auth.profile(user))
      if (method === 'POST' && pathname === '/api/password') return send(200, await auth.changePassword(request, response, user, value))
      if (user.must_change) bad('Change your temporary password to open the workspace.', 403)
      if (pathname.startsWith('/api/users')) {
        if (user.role !== 'admin') bad('Super admin access is required.', 403)
        if (method === 'GET' && pathname === '/api/users') return send(200, await auth.list())
        if (method === 'POST' && pathname === '/api/users') return send(201, await auth.add(value))
        const reset = /^\/api\/users\/([a-z0-9._-]+)\/password$/.exec(pathname)
        if (method === 'POST' && reset) {
          await auth.reset(reset[1], value?.password)
          return send(200, {})
        }
        bad('Page not found.', 404)
      }
      const actor = user.name === user.username ? user.name : `${user.name} (@${user.username})`
      const uploadMatch = /^\/api\/uploads\/([^/]+)\/(\d+)$/.exec(pathname)
      if (method === 'PUT' && uploadMatch) {
        const uploadId = uploadMatch[1]
        const part = Number(uploadMatch[2])
        const data = value?.data
        if (!uploadIdPattern.test(uploadId) || part > 25 || typeof data !== 'string' ||
          !data.length || data.length > 524288 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) bad('Invalid image upload part.')
        await db.execute('DELETE FROM image_uploads WHERE expires<=? LIMIT 100', [Date.now()])
        const { total } = await db.one('SELECT COUNT(DISTINCT upload_id) AS total FROM image_uploads WHERE username=?', [user.username])
        if (total >= 20 && !await db.one('SELECT 1 FROM image_uploads WHERE upload_id=? AND username=? LIMIT 1', [uploadId, user.username])) {
          bad('Too many pending image uploads. Try again after older uploads expire.')
        }
        await db.execute('INSERT INTO image_uploads(upload_id,username,part,data,expires) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data),expires=VALUES(expires)',
          [uploadId, user.username, part, data, Date.now() + 24 * 60 * 60 * 1000])
        return send(200, { uploaded: true })
      }
      if (method === 'POST' && pathname === '/api/projects') {
        if (user.role !== 'admin') bad('Super admin access is required.', 403)
        const name = field(value?.name, 180)
        if (!name) bad('Enter a project name.')
        try {
          await db.project.create({ data: { name } })
        } catch (error) {
          if (error.code === 'P2002') {
            bad('A project with that name already exists.', 409)
          }
          throw error
        }
        return send(201, { name })
      }
      if (method === 'GET' && pathname === '/api/workspace') {
        const [items, activity, members, projects] = await Promise.all([
          db.query('SELECT items.*, (SELECT COUNT(*) FROM items child WHERE child.parent_id=items.id) AS subtask_count, (SELECT COUNT(*) FROM items child WHERE child.parent_id=items.id AND child.status=\'Done\') AS subtask_done FROM items ORDER BY updated DESC,id DESC'),
          db.query('SELECT events.*, items.title FROM events JOIN items ON items.id=events.item_id ORDER BY at DESC, events.id DESC LIMIT 100'),
          auth.members(),
          db.query('SELECT name FROM projects ORDER BY name'),
        ])
        return send(200, { items, activity, members, projects: projects.map(project => project.name) })
      }
      if (method === 'POST' && pathname === '/api/items') {
        const item = itemFields(value)
        return send(201, await db.transaction(async connection => {
          if (value.parentId != null) {
            if (!Number.isSafeInteger(value.parentId) || value.parentId < 1 || value.parentId > 4294967295) bad('Choose a valid parent item.')
            const parent = await get(connection, value.parentId, true)
            item.parent_id = parent.id
            item.project = parent.project
          }
          const images = await resolveImages(connection, value?.images, user.username)
          item.project = await requireProject(connection, item.project)
          const at = now()
          const id = await add(connection, item, actor, 'Created', at)
          await saveDependencies(connection, id, item.parent_id, value.dependencyIds ?? [])
          if (item.parent_id) await log(connection, item.parent_id, 'Updated', actor, `Created subtask TL-${String(id).padStart(3, '0')}: ${item.title}`, 0, at)
          if (images.length) await saveImages(connection, id, images, at)
          return detail(connection, id)
        }))
      }
      if (method === 'POST' && pathname === '/api/import') {
        const rows = value
        if (!Array.isArray(rows) || !rows.length || rows.length > 1000) bad('Import between 1 and 1,000 rows at a time.')
        const items = rows.map((row, index) => {
          try { return itemFields(row) } catch (error) { bad(`Record ${index + 1}: ${error.message}`) }
        })
        return send(201, await db.transaction(async connection => {
          const projects = new Map()
          for (const [index, item] of items.entries()) {
            try {
              if (!projects.has(item.project)) projects.set(item.project, await requireProject(connection, item.project))
              item.project = projects.get(item.project)
            } catch (error) {
              if (error.status) bad(`Record ${index + 1}: ${error.message}`)
              throw error
            }
            await add(connection, item, actor, 'Imported')
          }
          return { count: items.length }
        }))
      }
      const delImgMatch = /^\/api\/items\/(\d+)\/images\/(\d+)$/.exec(pathname)
      if (method === 'DELETE' && delImgMatch) {
        const itemId = Number(delImgMatch[1])
        const imageId = Number(delImgMatch[2])
        return send(200, await db.transaction(async connection => {
          await get(connection, itemId, true)
          await connection.execute('DELETE FROM item_images WHERE id=? AND item_id=?', [imageId, itemId])
          await connection.execute('UPDATE items SET updated=? WHERE id=?', [now(), itemId])
          await log(connection, itemId, 'Updated', actor, 'Removed an image from description')
          return detail(connection, itemId)
        }))
      }
      const match = /^\/api\/items\/(\d+)(\/events|\/status)?$/.exec(pathname)
      if (!match) bad('Page not found.', 404)
      const id = Number(match[1])
      if (!Number.isSafeInteger(id) || id > 4294967295) bad('Work item not found.', 404)
      if (method === 'GET' && !match[2]) return send(200, await readTicket(db, id))
      if (method === 'PATCH' && match[2] === '/status' && url.searchParams.get('summary') === '1') {
        return send(200, await db.transaction(async connection => {
          const current = await get(connection, id, true)
          if (value?.version !== current.version) bad('This item changed since you opened it. Refresh or reopen it before trying again.', 409)
          if (!statuses.includes(value.status)) bad('Choose a valid status.')
          if (value.status === 'Done' && !current.resolution.trim()) bad('Add a resolution before marking this item done.')
          if (value.status === current.status) return current
          const updated = now()
          await connection.execute('UPDATE items SET status=?,updated=?,version=version+1 WHERE id=?', [value.status, updated, id])
          await log(connection, id, 'Updated', actor, `Status: ${current.status} → ${value.status}`, 0, updated)
          return { ...current, status: value.status, updated, version: current.version + 1 }
        }))
      }
      if (method === 'PATCH' && match[2] !== '/events') {
        return send(200, await db.transaction(async connection => {
          if (value?.dependencyIds !== undefined) {
            const preview = await get(connection, id)
            if (preview.parent_id) await get(connection, preview.parent_id, true)
          }
          const current = await get(connection, id, true)
          if (value?.version !== current.version) bad('This item changed since you opened it. Refresh or reopen it before trying again.', 409)
          const statusOnly = match[2] === '/status'
          if (statusOnly && !statuses.includes(value.status)) bad('Choose a valid status.')
          if (statusOnly && value.status === 'Done' && !current.resolution.trim()) bad('Add a resolution before marking this item done.')
          const item = statusOnly ? { ...current, status: value.status } : itemFields(value)
          const update = !statusOnly && value.update
          if (update && (!['Comment', 'Work log'].includes(update.kind) || !field(update.body) ||
            (update.kind === 'Work log' && (!Number.isInteger(update.minutes) || update.minutes < 1 || update.minutes > 1440)))) {
            bad('Add a comment or a work log with 1 to 1,440 minutes.')
          }
          if (item.project !== current.project) item.project = await requireProject(connection, item.project)
          const dependenciesChanged = !statusOnly && value.dependencyIds !== undefined
            ? await saveDependencies(connection, id, current.parent_id, value.dependencyIds) : false
          const changed = columns.filter(key => current[key] !== item[key])
          let imagesChanged = false
          if (!statusOnly && Array.isArray(value?.removedImageIds) && value.removedImageIds.length) {
            for (const imgId of value.removedImageIds.map(Number)) {
              if (Number.isSafeInteger(imgId) && imgId > 0) {
                await connection.execute('DELETE FROM item_images WHERE id=? AND item_id=?', [imgId, id])
                imagesChanged = true
              }
            }
          }
          const rawImages = statusOnly ? undefined : value?.newImages || (Array.isArray(value?.images) && value.images.some(img => img?.data) ? value.images.filter(img => img?.data) : undefined)
          const newImages = await resolveImages(connection, rawImages, user.username)
          if (newImages.length) {
            await saveImages(connection, id, newImages, now())
            imagesChanged = true
          }
          if (changed.length || dependenciesChanged) {
            const changes = changed.map(key => {
              const label = key[0].toUpperCase() + key.slice(1)
              return `${label}: ${current[key] || '—'} → ${item[key] || '—'}`
            })
            if (imagesChanged) changes.push('Images: updated description images')
            if (dependenciesChanged) changes.push('Updated subtask dependencies')
            await connection.execute(`UPDATE items SET ${columns.map(key => `${key}=?`).join(',')},updated=?,version=version+1 WHERE id=?`,
              [...columns.map(key => item[key]), now(), id])
            await log(connection, id, 'Updated', actor, changes.join('\n'))
          } else if (imagesChanged) {
            await connection.execute('UPDATE items SET updated=?,version=version+1 WHERE id=?', [now(), id])
            await log(connection, id, 'Updated', actor, 'Updated description images')
          }
          if (update) {
            await log(connection, id, update.kind, actor, field(update.body), update.kind === 'Work log' ? update.minutes : 0)
            await connection.execute('UPDATE items SET updated=? WHERE id=?', [now(), id])
          }
          return detail(connection, id)
        }))
      }
      if (method === 'POST' && match[2] === '/events') {
        const body = field(value?.body)
        const kind = value?.kind
        const minutes = kind === 'Work log' ? value.minutes : 0
        if (!['Comment', 'Work log'].includes(kind) || !body || !Number.isInteger(minutes) || (kind === 'Work log' && (minutes < 1 || minutes > 1440))) {
          bad('Add a comment or a work log with 1 to 1,440 minutes.')
        }
        return send(201, await db.transaction(async connection => {
          await get(connection, id, true)
          await log(connection, id, kind, actor, body, minutes)
          await connection.execute('UPDATE items SET updated=? WHERE id=?', [now(), id])
          return detail(connection, id)
        }))
      }
      bad('Method not supported.', 405)
    } catch (error) {
      if (error.status === 413 && !request.complete) {
        response.setHeader('Connection', 'close')
        request.resume()
      }
      if (!error.status) console.error('Trackline request failed:', error.code || error.name, error.message)
      send(error.status || 500, { error: error.status ? error.message : (error.code ? `Database connection failed (${error.code}).` : (error.message || 'The tracker could not complete this request.')) })
    }
  }
}

export function startServer(db, { host, port, origin }) {
  const server = createServer(createRequestHandler(db, { origin }))
  server.on('close', () => { void db.close() })
  server.listen(port, host, () => console.log(`Trackline listening at ${origin || `http://${host.includes(':') ? '[' + host + ']' : host}:${server.address().port}`}`))
  return server
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const initialize = process.argv.includes('--init-admin')
  const host = process.env.TRACKLINE_HOST || '127.0.0.1'
  const port = Number(process.env.TRACKLINE_PORT || 4173)
  const origin = process.env.TRACKLINE_ORIGIN
  if (origin && (new URL(origin).origin !== origin || !origin.startsWith('https://'))) throw new Error('TRACKLINE_ORIGIN must be an HTTPS origin with no trailing slash.')
  if (!initialize && !origin && !['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Configure the public HTTPS TRACKLINE_ORIGIN before binding outside loopback.')
  const db = connectDatabase(await mysqlConfig())
  const auth = createAuth(db, { origin })
  try {
    if (initialize) {
      const username = process.env.TRACKLINE_ADMIN_USERNAME || 'admin'
      const name = process.env.TRACKLINE_ADMIN_NAME || 'Administrator'
      const password = process.env.TRACKLINE_ADMIN_PASSWORD || 'Admin@Trackline2026!'
      const mustChange = ['1', 'true'].includes((process.env.TRACKLINE_ADMIN_MUST_CHANGE ?? (process.env.TRACKLINE_ADMIN_PASSWORD ? 'false' : 'true')).toLowerCase())
      await auth.initializeAdmin({ username, name, password, mustChange })
      await db.close()
      console.log('Super admin created.')
    } else {
      if (!await auth.hasAdmin()) throw new Error('Initialize the super admin with npm run init-admin first.')
      startServer(db, { host, port, origin })
    }
  } catch (error) {
    await db.close()
    console.error(error.code ? 'MySQL setup failed. Check DATABASE_URL and run npm run db:deploy before starting.' : error.message)
    process.exitCode = 1
  }
}
