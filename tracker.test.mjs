import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import { createRequestHandler } from './server.mjs'
import { connectDatabase, mysqlConfig } from './database.mjs'
import { createAuth } from './auth.mjs'
import { encodeCSV, parseImport } from './public/csv.js'

const admin = { username: 'qa-admin', name: 'QA Admin', password: 'temporary admin test password' }
const mysqlTests = { skip: process.env.MYSQL_TEST === '1' ? false : 'Set MYSQL_TEST=1 with a disposable MySQL server.' }
const run = promisify(execFile)

async function testDatabase(t) {
  const config = await mysqlConfig()
  const operator = connectDatabase(config)
  const database = 'trackline_test_' + randomUUID().replaceAll('-', '')
  t.after(async () => {
    try { await operator.execute('DROP DATABASE IF EXISTS ' + database) } finally { await operator.close() }
  })
  await operator.execute('CREATE DATABASE ' + database)
  const url = new URL(process.env.DATABASE_URL)
  url.pathname = '/' + database
  await run(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url.href },
  })
  return { ...config, database }
}

async function start(config, { seed = true, signIn = true, publicOrigin, projectNames = ['Billing', 'Platform', 'Design'] } = {}) {
  const db = connectDatabase(config)
  if (seed) {
    await createAuth(db).initializeAdmin(admin)
    await db.project.createMany({ data: projectNames.map(name => ({ name })) })
  }
  const server = createServer(createRequestHandler(db, { origin: publicOrigin }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const client = () => {
    let cookie
    return {
    async request(path, method = 'GET', body, headers = {}) {
      const response = await fetch(origin + path, {
        method,
        headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { origin: publicOrigin || origin, 'content-type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const setCookie = response.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';')[0]
      return {
        status: response.status,
        data: (response.headers.get('content-type') || '').includes('application/json') ? await response.json() : await response.text(),
      }
    },
    cookie: () => cookie,
    }
  }
  const app = client()
  if (signIn) assert.equal((await app.request('/api/session', 'POST', admin)).status, 200)
  return { ...app, client, async close() {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await db.close()
  } }
}

test('an issue preserves discussion, time, resolution and history across restart', mysqlTests, async t => {
  const config = await testDatabase(t)
  let app = await start(config)
  t.after(() => app.close())
  assert.match((await app.request('/')).data, /Trackline/)
  const created = await app.request('/api/items', 'POST', { title: 'Fix invoice', project: 'Billing', type: 'Bug' })
  assert.equal(created.status, 201)
  const { id } = created.data
  const path = '/api/items/' + id
  assert.equal((await app.request(path + '/events', 'POST', { kind: 'Comment', body: 'Reproduced the issue.' })).status, 201)
  assert.equal((await app.request(path + '/events', 'POST', { kind: 'Work log', body: 'Reviewed invoice samples.', minutes: 25 })).status, 201)
  assert.equal((await app.request(path + '/events', 'POST', { kind: 'Work log', body: 'Invalid log', minutes: 0 })).status, 400)
  assert.equal((await app.request(path, 'PATCH', { ...created.data, status: 'Done' })).status, 400)
  const edits = await Promise.all([1, 2].map(() => app.request(path, 'PATCH', { ...created.data, status: 'Done', resolution: 'Verified invoice totals.' })))
  assert.deepEqual(edits.map(edit => edit.status).sort(), [200, 409])
  assert.equal((await app.request(path, 'PATCH', { ...created.data, owner: 'Another editor' })).status, 409)
  await app.close()
  app = await start(config, { seed: false })
  const reopened = (await app.request(path)).data
  assert.equal(reopened.status, 'Done')
  assert.equal(reopened.resolution, 'Verified invoice totals.')
  assert.deepEqual(reopened.events.map(event => event.kind), ['Updated', 'Work log', 'Comment', 'Created'])
  assert.equal(reopened.events[1].minutes, 25)
  assert.match(reopened.events[0].body, /To do → Done/)
})

function csvRows() {
  return parseImport('\uFEFFTitle,Project,Type,Description\r\n"Review ""A"", then B",Platform,bug,"Line 1\r\nLine 2"\r\n')
}

test('CSV parses Excel quoting and escapes formula cells', () => {
  const rows = csvRows()
  assert.equal(rows[0].title, 'Review "A", then B')
  assert.equal(rows[0].type, 'Bug')
  assert.equal(rows[0].description, 'Line 1\r\nLine 2')
  assert.throws(() => parseImport('Title,Project\n"Unclosed,Project'))
  assert.match(encodeCSV([['=2+2']]), /^"'=/)
})

test('CSV import rejects a bad batch before saving any rows', mysqlTests, async t => {
  const app = await start(await testDatabase(t))
  t.after(() => app.close())
  const rows = csvRows()
  const badBatch = await app.request('/api/import', 'POST', [...rows, { title: 'Invalid due date', project: 'Platform', due: '2026-02-30' }])
  assert.equal(badBatch.status, 400)
  assert.match(badBatch.data.error, /Record 2/)
  assert.equal((await app.request('/api/workspace')).data.items.length, 0)
  assert.deepEqual(await app.request('/api/import', 'POST', rows), { status: 201, data: { count: 1 } })
  const added = (await app.request('/api/workspace')).data
  assert.equal(added.items[0].title, rows[0].title)
  assert.equal(added.activity[0].kind, 'Imported')
})

test('a single super admin provisions team accounts and members must replace temporary passwords', mysqlTests, async t => {
  const app = await start(await testDatabase(t), { signIn: false })
  t.after(() => app.close())
  assert.equal((await app.request('/')).status, 200)
  assert.equal((await app.request('/api/workspace')).status, 401)
  assert.equal((await app.request('/api/session', 'POST', admin, { origin: 'https://unrelated.example' })).status, 415)
  assert.equal((await app.request('/api/session', 'POST', { ...admin, password: 'wrong' })).status, 401)
  assert.equal((await app.request('/api/session', 'POST', admin)).status, 200)
  assert.deepEqual((await app.request('/api/workspace')).data.items, [])
  const teammate = { username: 'QA-Member', name: 'QA Member', password: 'temporary member test password', role: 'admin' }
  assert.deepEqual(await app.request('/api/users', 'POST', teammate), {
    status: 201, data: { username: 'qa-member', name: 'QA Member', role: 'member', mustChangePassword: true },
  })
  assert.equal((await app.request('/api/users', 'POST', teammate)).status, 409)
  const member = app.client()
  assert.equal((await member.request('/api/session', 'POST', teammate)).data.mustChangePassword, true)
  const firstSession = member.cookie()
  assert.equal((await member.request('/api/workspace')).status, 403)
  assert.equal((await member.request('/api/password', 'POST', { currentPassword: teammate.password, password: teammate.password })).status, 400)
  const password = 'replacement member test password'
  assert.equal((await member.request('/api/password', 'POST', { currentPassword: teammate.password, password })).data.mustChangePassword, false)
  assert.equal((await member.request('/api/session', 'GET', undefined, { cookie: firstSession })).status, 401)
  assert.equal((await member.request('/api/users')).status, 403)
  assert.equal((await member.request('/api/users', 'POST', teammate)).status, 403)
  assert.equal((await member.request('/api/projects', 'POST', { name: 'Another project' })).status, 403)
  const created = await member.request('/api/items', 'POST', { title: 'Test', project: 'Billing' })
  assert.equal(created.status, 201)
  assert.equal(created.data.events[0].actor, 'QA Member (@qa-member)')
  assert.equal((await app.request('/api/workspace')).data.items[0].id, created.data.id)
  assert.equal((await app.request('/api/users/qa-admin/password', 'POST', { password })).status, 404)
  assert.equal((await app.request('/api/users/qa-member/password', 'POST', { password: teammate.password })).status, 200)
  assert.equal((await member.request('/api/workspace')).status, 401)
  assert.equal((await member.request('/api/session', 'POST', { ...teammate, password })).status, 401)
  assert.equal((await member.request('/api/session', 'POST', teammate)).data.mustChangePassword, true)
  assert.equal((await app.request('/api/session', 'DELETE', {})).status, 200)
  assert.equal((await app.request('/api/workspace')).status, 401)
})

test('projects are managed centrally and board status moves preserve ticket details and history', mysqlTests, async t => {
  const app = await start(await testDatabase(t), { projectNames: [] })
  t.after(() => app.close())
  assert.deepEqual((await app.request('/api/workspace')).data.projects, [])
  const draft = { title: 'Fix invoice', project: 'Billing', type: 'Bug', description: 'Existing description' }
  assert.equal((await app.request('/api/items', 'POST', draft)).status, 400)
  assert.equal((await app.request('/api/projects', 'POST', { name: ' Billing ' })).status, 201)
  assert.equal((await app.request('/api/projects', 'POST', { name: 'billing' })).status, 409)
  assert.deepEqual((await app.request('/api/workspace')).data.projects, ['Billing'])
  assert.equal((await app.request('/api/import', 'POST', [draft, { ...draft, project: 'Missing' }])).status, 400)
  assert.deepEqual((await app.request('/api/workspace')).data.items, [])
  const created = await app.request('/api/items', 'POST', { ...draft, project: 'billing' })
  assert.equal(created.status, 201)
  assert.equal(created.data.project, 'Billing')
  const path = '/api/items/' + created.data.id
  const moved = await app.request(path + '/status', 'PATCH', { status: 'In progress', version: created.data.version, description: 'Ignored' })
  assert.equal(moved.status, 200)
  assert.equal(moved.data.status, 'In progress')
  assert.equal(moved.data.description, draft.description)
  assert.match(moved.data.events[0].body, /To do → In progress/)
  assert.equal((await app.request(path + '/status', 'PATCH', { status: 'Blocked', version: created.data.version })).status, 409)
  assert.equal((await app.request(path + '/status', 'PATCH', { status: 'Done', version: moved.data.version })).status, 400)
  assert.equal((await app.request(path, 'PATCH', { ...moved.data, status: 'Done', resolution: 'Verified' })).status, 200)
})

test('deployed HTTPS origin issues a secure same-origin session', mysqlTests, async t => {
  const config = await testDatabase(t)
  const app = await start(config, { publicOrigin: 'https://tracker.example.com', signIn: false })
  t.after(() => app.close())
  const db = connectDatabase(config)
  try {
    await assert.rejects(createAuth(db).initializeAdmin({ ...admin, username: 'another-admin' }), { status: 409 })
  } finally { await db.close() }
  assert.equal((await app.request('/api/session', 'POST', admin, { origin: 'https://other.example.com' })).status, 415)
  assert.equal((await app.request('/api/session', 'POST', admin)).status, 200)
  assert.match(app.cookie(), /^__Host-trackline=/)
  assert.deepEqual((await app.request('/api/workspace')).data.items, [])
})

test('creating a work item with description images stores and serves images', mysqlTests, async t => {
  const app = await start(await testDatabase(t))
  t.after(() => app.close())
  const sampleImage = {
    filename: 'screenshot.png',
    mimeType: 'image/png',
    data: Buffer.from('fake-png-data').toString('base64'),
  }
  const created = await app.request('/api/items', 'POST', {
    title: 'Item with screenshot',
    project: 'Design',
    description: 'See the attached screenshot',
    images: [sampleImage],
  })
  assert.equal(created.status, 201)
  assert.equal(created.data.images.length, 1)
  assert.equal(created.data.images[0].filename, 'screenshot.png')
  const imageId = created.data.images[0].id
  const imgRes = await app.request(`/api/images/${imageId}`)
  assert.equal(imgRes.status, 200)
  assert.equal(imgRes.data, 'fake-png-data')
})

