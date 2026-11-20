import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const source = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8')
const moveSource = source.slice(source.indexOf('async function moveBoardItem('), source.indexOf('const clearDropTarget'))
const refreshSource = source.slice(source.indexOf('async function refresh()'), source.indexOf('async function refreshAfterSave()'))
function deferred() {
  let resolve, reject
  const promise = new Promise((success, failure) => { resolve = success; reject = failure })
  return { promise, resolve, reject }
}
function boardState(api) {
  const item = { id: 1, status: 'To do', version: 1, resolution: '', updated: '2026-11-18T00:00:00.000Z' }
  const renders = []
  const context = {
    api, item, renders, movingItems: new Set(), workspaceRequest: 0,
    session: { name: 'Tester' }, boardRefreshTimer: undefined, lastWorkspace: '', workspaceLoaded: true,
    draggedItem: undefined, view: 'board',
    workspace: { items: [item] },
    render: () => renders.push(item.status),
    notify: () => {}, ref: id => 'TL-' + id,
    clearTimeout: () => {}, setTimeout: () => 1,
    document: { querySelector: () => null },
    $: () => ({ setAttribute() {}, elements: { resolution: { focus() {} } } }),
    fillDrawer: detail => { context.drawer = detail },
  }
  runInNewContext(refreshSource + '\n' + moveSource, context)
  return context
}

test('a board move renders immediately, then uses the server version when saved', async () => {
  const request = deferred()
  const calls = []
  const state = boardState((...args) => { calls.push(args); return request.promise })
  const moving = state.moveBoardItem(state.item, 'In progress')
  assert.equal(state.item.status, 'In progress')
  assert.deepEqual(state.renders, ['In progress'])
  assert.equal(state.movingItems.has(1), true)
  assert.equal(calls[0][0], '/api/items/1/status?summary=1')
  assert.equal(calls[0][2].version, 1)
  request.resolve({ ...state.item, version: 2 })
  await moving
  assert.equal(state.item.version, 2)
  assert.equal(state.movingItems.size, 0)
})

test('a failed board move rolls back and repeated moves on the same pending card are ignored', async () => {
  const request = deferred()
  let calls = 0
  const state = boardState(() => { calls++; return request.promise })
  const before = { ...state.item }
  const moving = state.moveBoardItem(state.item, 'Blocked')
  await state.moveBoardItem(state.item, 'In review')
  assert.equal(calls, 1)
  request.reject(Object.assign(new Error('Conflict'), { status: 409 }))
  await moving
  assert.deepEqual(state.item, before)
  assert.equal(state.movingItems.size, 0)
  assert.deepEqual(state.renders, ['Blocked', 'To do'])
})

test('a poll started before a board save cannot overwrite the confirmed move', async () => {
  const poll = deferred()
  const save = deferred()
  const state = boardState(path => path === '/api/workspace' ? poll.promise : save.promise)
  const oldItem = { ...state.item }
  const refreshing = state.refresh()
  const moving = state.moveBoardItem(state.item, 'In review')
  save.resolve({ ...state.item, version: 2 })
  await moving
  poll.resolve({ items: [oldItem] })
  await refreshing
  assert.equal(state.workspace.items[0].status, 'In review')
  assert.equal(state.workspace.items[0].version, 2)
})

test('Done still opens the resolution form before persisting a status', async () => {
  const calls = []
  const state = boardState(async path => { calls.push(path); return { id: 1, status: 'To do' } })
  await state.moveBoardItem(state.item, 'Done')
  assert.deepEqual(calls, ['/api/items/1'])
  assert.equal(state.item.status, 'To do')
  assert.equal(state.drawer.status, 'Done')
})

test('a drop changes status and suppresses the release click while the next normal click still opens the card', () => {
  const handlers = new Map()
  const main = { addEventListener: (type, handler) => handlers.set(type, handler) }
  const item = { id: 1, status: 'To do' }
  const moves = []
  const classes = new Set()
  const card = {
    dataset: { boardItem: '1' },
    classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
  }
  const column = {
    dataset: { boardStatus: 'In progress' },
    classList: { contains: () => false, add() {}, remove() {} },
  }
  const target = {
    closest(selector) {
      return selector === '.board-card' ? card : selector === '.board-col' ? column : selector === '.board' ? main : null
    },
  }
  const context = {
    $: selector => selector === '#main' ? main : null,
    workspace: { items: [item] }, movingItems: new Set(), draggedItem: undefined,
    suppressBoardClick: false, renderAfterDrag: false,
    ref: id => 'TL-' + id, moveBoardItem: (...args) => moves.push(args),
  }
  const start = source.indexOf('const clearDropTarget')
  const end = source.indexOf("document.addEventListener('click'", start)
  runInNewContext(source.slice(start, end), context)
  const event = () => ({
    target, detail: 1, prevented: false, stopped: false,
    preventDefault() { this.prevented = true }, stopPropagation() {},
    stopImmediatePropagation() { this.stopped = true },
    dataTransfer: { setData() {} },
  })
  handlers.get('pointerdown')(event())
  handlers.get('dragstart')(event())
  const over = event()
  handlers.get('dragover')(over)
  assert.equal(over.prevented, true)
  handlers.get('drop')(event())
  assert.equal(moves.length, 1)
  assert.equal(moves[0][0], item)
  assert.equal(moves[0][1], 'In progress')
  const releaseClick = event()
  handlers.get('click')(releaseClick)
  assert.equal(releaseClick.stopped, true)
  handlers.get('pointerdown')(event())
  const intentionalClick = event()
  handlers.get('click')(intentionalClick)
  assert.equal(intentionalClick.stopped, false)
  handlers.get('keydown')(event())
  const keyboardClick = { ...event(), detail: 0 }
  handlers.get('click')(keyboardClick)
  assert.equal(keyboardClick.stopped, false)
})
