import { parseImport, encodeCSV } from './csv.js'

const icons = {
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  board: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m6-16v16"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  upload: '<path d="M12 16V4m-4 4 4-4 4 4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 10h18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
  alert: '<path d="m12 4 9 16H3L12 4Zm0 6v4m0 3h.01"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  bug: '<rect x="7" y="7" width="10" height="13" rx="5"/><path d="m9 4 1 3m5-3-1 3M7 11H4m3 5H4m13-5h3m-3 5h3m-8-5v8"/>',
  spark: '<path d="M12 2c1 7 3 9 10 10-7 1-9 3-10 10-1-7-3-9-10-10 7-1 9-3 10-10Z"/>',
  tool: '<path d="m13 7 4 4 4-4a6 6 0 0 1-7 8l-6 6-4-4 6-6a6 6 0 0 1 8-7l-5 3Z"/>',
  task: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  download: '<path d="M12 4v12m-4-4 4 4 4-4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2m1-15a3 3 0 0 1 0 6m2 3a4 4 0 0 1 3 4v2"/>',
  logout: '<path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5m-1-8h12m-4-4 4 4-4 4"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
}
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const $ = selector => document.querySelector(selector)
const statuses = ['To do', 'In progress', 'Blocked', 'In review', 'Done']
const types = ['Feature', 'Bug', 'Fix', 'Task']
const priorities = ['Low', 'Medium', 'High', 'Urgent']
const nav = [['overview', 'Overview', 'grid'], ['work', 'All work', 'list'], ['board', 'Board', 'board'], ['activity', 'Activity', 'activity'], ['team', 'Team members', 'users']]
const fields = ['title','type','project','owner','status','priority','due','description','resolution']
const workspace = { items: [], activity: [], members: [], projects: [] }
let session
let team = null
const filters = { search: '', project: '', status: '', type: '', owner: '', priority: '', focus: '' }
let view = 'overview'
let toastTimer, openRequest = 0, workspaceRequest = 0
let lastWorkspace = ''
let workspaceLoaded = false
let draggedItem
const movingItems = new Set()
let boardRefreshTimer
let renderAfterDrag = false
let suppressBoardClick = false

function staticIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon) })
}
function notify(message) {
  const toast = $('#toast')
  toast.textContent = message
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toast.textContent = '' }, 3200)
}
async function api(path, method = 'GET', body) {
  let response
  try {
    response = await fetch(path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    throw new Error(method === 'GET' ? 'Could not reach Trackline. Check your connection and try again.'
      : 'Trackline did not confirm this change. Check the incident before retrying. Your draft is still open.')
  }
  const result = await response.json().catch(() => null)
  if (!response.ok) {
    if (response.status === 401 && session) showAccount()
    const message = response.status === 413 ? 'The server rejected an upload because it is too large. Try fewer or smaller attachments.'
      : `Trackline returned HTTP ${response.status}. Your draft is still open.`
    throw Object.assign(new Error(result?.error || message), { status: response.status })
  }
  if (result === null) throw new Error('Trackline returned an empty or unreadable response. Check the incident before retrying. Your draft is still open.')
  return result
}

async function uploadImages(images, onProgress) {
  const results = []
  for (const [index, image] of images.entries()) {
    if (Date.now() - (image.uploadStartedAt || 0) > 23 * 60 * 60 * 1000) {
      image.uploadId = undefined
      image.uploadedParts = 0
      image.uploadStartedAt = Date.now()
    }
    image.uploadId ||= crypto.randomUUID()
    const parts = Math.ceil(image.data.length / 524288)
    for (let part = image.uploadedParts || 0; part < parts; part++) {
      onProgress(`Uploading image ${index + 1} of ${images.length} · ${Math.round(part / parts * 100)}%`)
      await api(`/api/uploads/${image.uploadId}/${part}`, 'PUT', { data: image.data.slice(part * 524288, (part + 1) * 524288) })
      image.uploadedParts = part + 1
    }
    results.push({ uploadId: image.uploadId, parts, filename: image.filename, mimeType: image.mimeType })
  }
  return results
}
function showAccount(user = null, change = false) {
  session = user
  const needsPassword = !!user && (user.mustChangePassword || change)
  const inWorkspace = !!user && !needsPassword
  $('#auth-page').hidden = inWorkspace
  $('#workspace').hidden = !inWorkspace
  $('#auth-status').hidden = true
  $('#login-form').hidden = !!user
  $('#password-form').hidden = !needsPassword
  for (const form of [$('#login-form'), $('#password-form')]) {
    form.reset()
    form.querySelector('.form-error').textContent = ''
  }
  if (!inWorkspace) {
    setMenu(false)
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close())
    document.querySelectorAll('dialog form').forEach(form => form.reset())
    $('#item-dialog').replaceChildren()
    $('#reset-context').textContent = ''
    $('#reset-form').removeAttribute('data-username')
    if (!user) {
      workspaceRequest++
      openRequest++
      Object.assign(workspace, { items: [], activity: [], members: [], projects: [] })
      lastWorkspace = ''
      workspaceLoaded = false
      team = null
      history.replaceState(null, '', '#overview')
      $('#search').value = ''
      $('#main').replaceChildren()
      $('#workspace-nav').replaceChildren()
      $('#project-nav').replaceChildren()
      $('#profile-name').textContent = ''
      $('#profile-avatar').textContent = ''
    }
  }
  if (needsPassword) {
    $('#password-context').textContent = user.mustChangePassword ? 'Replace your temporary password to open the workspace.' : 'Choose a new password with at least 12 characters.'
    $('#password-cancel').hidden = user.mustChangePassword
    $('#password-form').elements.currentPassword.focus()
  } else if (!user) {
    $('#login-form').elements.username.focus()
  } else {
    readRoute()
    refresh().catch(error => {
      if (!session) return
      if (!workspaceLoaded) {
        $('#main').setAttribute('aria-busy', 'false')
        $('#main').innerHTML = '<div class="workspace-loading"><p>Could not load your workspace.</p><button class="button secondary" data-action="retry-workspace">Try again</button></div>'
      }
      notify(error.message)
    })
  }
}
async function refresh() {
  if (movingItems.size) return
  const request = ++workspaceRequest
  const result = await api('/api/workspace')
  if (request !== workspaceRequest || draggedItem || movingItems.size) return
  const snapshot = JSON.stringify(result)
  if (snapshot === lastWorkspace) return
  lastWorkspace = snapshot
  Object.assign(workspace, result)
  workspaceLoaded = true
  $('#main').setAttribute('aria-busy', 'false')
  render()
}
async function refreshAfterSave() {
  try { await refresh() } catch { notify('Changes were saved. Reload to refresh the workspace.') }
}
function color(value) {
  return 'c' + ([...value].reduce((sum, char) => sum + char.codePointAt(0), 0) % 5)
}
function avatar(name) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase()
  return `<span class="avatar ${color(name)}" aria-hidden="true">${esc(initials || '—')}</span>`
}
function localDay(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-')
}
const shortDate = value => value ? new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(value + 'T12:00:00')) : '—'
const timestamp = value => new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value))
const overdue = item => item.status !== 'Done' && !!item.due && item.due < localDay()
const stale = item => item.status !== 'Done' && Date.now() - Date.parse(item.updated) >= 7 * 86400000
const focusChecks = { active: item => ['In progress', 'In review'].includes(item.status), overdue, done: item => item.status === 'Done',
  attention: item => overdue(item) || stale(item) || item.status === 'Blocked' || (item.status !== 'Done' && !item.owner) }
const focusLabels = { active: 'In flight', overdue: 'Overdue', done: 'Completed', attention: 'Needs attention' }
const ref = id => 'TL-' + String(id).padStart(3, '0')
const projects = () => workspace.projects
const projectMatches = (left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }) === 0
const owners = () => [...new Set([...workspace.members, ...workspace.items.map(item => item.owner).filter(Boolean)])].sort((a,b) => a.localeCompare(b))
const statusPill = status => `<span class="pill status status-${statuses.indexOf(status)}">${esc(status)}</span>`
const typeIcon = type => `<span class="type-icon type-${type.toLowerCase()}" title="${type}">${icon({ Bug: 'bug', Feature: 'spark', Fix: 'tool', Task: 'task' }[type])}</span>`
const empty = message => `<p class="empty">${message}</p>`
const option = (value, selected, label = value) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`

function readRoute() {
  if (!session || $('#workspace').hidden) return
  if (draggedItem) endBoardDrag()
  const [route, query = ''] = location.hash.slice(1).split('?')
  const params = new URLSearchParams(query)
  view = nav.some(([key]) => key === route) && (route !== 'team' || session.role === 'admin') ? route : 'overview'
  for (const key of Object.keys(filters)) filters[key] = params.get(key) || ''
  if (!Object.hasOwn(focusChecks, filters.focus)) filters.focus = ''
  $('#search').value = filters.search
  render()
  if (view === 'team' && team === null) loadTeam()
}
function routeTo(next, values = {}, replace = false) {
  const params = new URLSearchParams(Object.entries(values).filter(([, value]) => value))
  const hash = '#' + next + (params.size ? '?' + params : '')
  if (replace) history.replaceState(null, '', hash)
  else if (location.hash !== hash) history.pushState(null, '', hash)
  readRoute()
}
function filteredItems() {
  const query = filters.search.toLowerCase().trim()
  return workspace.items.filter(item =>
    (!filters.project || projectMatches(item.project, filters.project)) &&
    (!filters.status || item.status === filters.status) &&
    (!filters.type || item.type === filters.type) &&
    (!filters.owner || (filters.owner === ':unassigned' ? !item.owner : item.owner === filters.owner)) &&
    (!filters.priority || item.priority === filters.priority) &&
    (!filters.focus || focusChecks[filters.focus](item)) &&
    (!query || [ref(item.id), item.title, item.description, item.resolution, item.owner, item.project].some(value => value.toLowerCase().includes(query))))
}
function renderNav() {
  $('#new-project').hidden = session.role !== 'admin'
  $('#workspace-nav').innerHTML = nav.filter(([key]) => key !== 'team' || session.role === 'admin').map(([key, label, graphic]) => `<button class="nav-item${view === key && !filters.project ? ' active' : ''}" data-view="${key}"${view === key && !filters.project ? ' aria-current="page"' : ''}>${icon(graphic)}${label}</button>`).join('')
  $('#project-nav').innerHTML = projects().map(project => `<button class="nav-item${filters.project === project ? ' active' : ''}" data-project="${esc(project)}"${filters.project === project ? ' aria-current="page"' : ''}><span class="project-dot ${color(project)}"></span><span class="truncate">${esc(project)}</span><span class="count">${workspace.items.filter(item => projectMatches(item.project, project) && item.status !== 'Done').length}</span></button>`).join('')
  $('#profile-avatar').outerHTML = avatar(session.name).replace('class=', 'id="profile-avatar" class=')
  $('#profile-name').textContent = session.name
  $('#profile-context').textContent = session.role === 'admin' ? 'Super admin' : 'Workspace member'
  $('#crumb').textContent = filters.project || nav.find(([key]) => key === view)[1]
}
function heading(title, description, action = '', label = '') {
  return `<div class="page-heading"><div>${label ? `<p class="eyebrow">${label}</p>` : ''}<h1>${esc(title)}</h1><p>${description}</p></div>${action}</div>`
}
function table(items) {
  if (!items.length) return empty('No work items match this view.')
  return `<div class="table-wrap"><table class="work-table"><thead><tr><th>Work item</th><th>Project</th><th>Status</th><th>Priority</th><th>Assignee</th><th>Due date</th></tr></thead><tbody>${items.map(item =>
    `<tr><td><button class="item-link" data-id="${item.id}">${typeIcon(item.type)}<span>${esc(item.title)}<small>${ref(item.id)} · ${item.type}</small>${subtaskContext(item)}</span></button></td><td><span class="inline-owner"><span class="project-dot ${color(item.project)}"></span>${esc(item.project)}</span></td><td>${statusPill(item.status)}</td><td><span class="priority ${item.priority.toLowerCase()}">${item.priority}</span></td><td><span class="inline-owner">${item.owner ? avatar(item.owner) + esc(item.owner) : 'Unassigned'}</span></td><td class="${overdue(item) ? 'due-late' : ''}">${shortDate(item.due)}</td></tr>`).join('')}</tbody></table></div>`
}
function attentionRow(item) {
  const reasons = []
  if (overdue(item)) reasons.push(['overdue', 'Overdue'])
  if (item.status === 'Blocked') reasons.push(['blocked', 'Blocked'])
  if (stale(item)) reasons.push(['stale', 'Stale'])
  if (!item.owner) reasons.push(['unassigned', 'Unassigned'])
  const [tone, label] = reasons[0]
  return `<button class="attention-row" data-id="${item.id}">${typeIcon(item.type)}<div><strong>${esc(item.title)}</strong><small>${esc(item.project)} · ${esc(item.owner || 'Unassigned')}${reasons.length > 1 ? ' · ' + reasons.slice(1).map(([, name]) => name).join(', ') : ''}</small></div><span class="pill ${tone}">${label}</span>${icon('chevron')}</button>`
}
function heroArt() {
  return `<div class="hero-art" aria-hidden="true"><svg viewBox="0 0 360 152" preserveAspectRatio="xMidYMid slice" fill="none"><defs><pattern id="dots" width="15" height="15" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="#d4baff" opacity=".25"/></pattern></defs><rect width="360" height="152" fill="url(#dots)"/><path d="M72 151c31-92 77-152 204-167M106 153C144 53 203 9 339-6M140 155C196 61 258 40 372 56" stroke="#cfb8ff" opacity=".23"/><g transform="translate(143 23) rotate(-10 87 46)"><rect x="10" y="9" width="175" height="94" rx="13" fill="#2b1d59" opacity=".38"/><rect width="175" height="94" rx="13" fill="#8a6bd2" fill-opacity=".65" stroke="#b89af0"/><rect x="15" y="16" width="34" height="25" rx="6" fill="#bda6f1"/><path d="m24 28 6 5 9-10" stroke="#513694" stroke-width="2.5" stroke-linecap="round"/><rect x="61" y="20" width="84" height="5" rx="2.5" fill="#e1d2fc"/><rect x="61" y="31" width="60" height="4" rx="2" fill="#c0abe8"/><rect x="15" y="53" width="145" height="8" rx="4" fill="#6b4cae"/><rect x="15" y="53" width="113" height="8" rx="4" fill="#d3bafa"/><rect x="15" y="70" width="145" height="8" rx="4" fill="#6b4cae"/><rect x="15" y="70" width="78" height="8" rx="4" fill="#a795ff"/></g><path d="M99 49h16m-8-8v16M313 116h14m-7-7v14M318 19h12m-6-6v12" stroke="#dbcbff" stroke-width="1.5" stroke-linecap="round"/></svg></div>`
}
function overview() {
  const items = workspace.items
  const attention = items.filter(focusChecks.attention).sort((a,b) => Number(overdue(b)) - Number(overdue(a)) || a.updated.localeCompare(b.updated))
  const metrics = [
    ['Total items', items.length, 'All tracked work', 'layers', '', ''],
    ['In flight', items.filter(focusChecks.active).length, 'In progress or in review', 'clock', 'blue', 'active'],
    ['Overdue', items.filter(overdue).length, 'Past the due date', 'alert', 'red', 'overdue'],
    ['Completed', items.filter(focusChecks.done).length, 'Resolved and closed', 'check', 'green', 'done'],
  ]
  return heading('Workspace overview', 'See what’s moving, what’s blocked, and what needs a follow-up.',
    `<div class="heading-date">${icon('calendar')}${esc(new Intl.DateTimeFormat('en', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date()))}</div>`) +
    `<section class="hero">${heroArt()}<h2>${attention.length ? `${attention.length} open ${attention.length === 1 ? 'item needs' : 'items need'} attention` : 'Your work is up to date'}</h2><p>${attention.length ? 'Follow up on blocked, overdue, stale, and unassigned work.' : 'Add a work item or import the tasks your team already tracks.'}</p><button class="button" data-action="${attention.length ? 'focus' : 'create'}" data-focus="attention">${attention.length ? 'Review items' : 'Create a work item'} ${icon('arrow')}</button></section>
    <div class="stats">${metrics.map(([label, count, hint, graphic, tone, focus]) => `<button class="stat" data-action="focus" data-focus="${focus}"><span class="stat-top">${label}<span class="stat-icon ${tone}">${icon(graphic)}</span></span><strong>${count}</strong><small>${hint}</small></button>`).join('')}</div>
    <div class="overview-grid">
      <section class="panel"><div class="panel-head"><div><h2>Needs attention</h2><p>Stale items have had no update for 7 days.</p></div><button class="text-button" data-action="focus" data-focus="attention">View all</button></div>${attention.slice(0, 4).map(attentionRow).join('') || empty('No items need attention.')}</section>
      <section class="panel"><div class="panel-head"><div><h2>Work by status</h2><p>${items.length} ${items.length === 1 ? 'item' : 'items'} across the workspace</p></div></div><div class="progress-content">${statuses.map((status, index) => {
        const count = items.filter(item => item.status === status).length
        return `<div class="progress-row status-${index}"><span>${status}</span><div class="meter"><progress value="${count}" max="${items.length || 1}" aria-label="${status}"></progress></div><b>${count}</b></div>`
      }).join('')}</div></section>
    </div>
    <section class="panel"><div class="panel-head"><div><h2>Recently updated</h2><p>Latest changes across your projects</p></div><button class="text-button" data-view="work">All work</button></div>${table(items.slice(0, 5))}</section>`
}
function filterSelect(key, title, values) {
  return `<select data-filter="${key}" aria-label="${title}">${option('', filters[key], title)}${values.map(value => Array.isArray(value) ? option(value[0], filters[key], value[1]) : option(value, filters[key])).join('')}</select>`
}
function board(items) {
  return `<div class="board" aria-label="Work board">${statuses.map(status => {
    const cards = items.filter(item => item.status === status)
    return `<section class="board-col" data-board-status="${status}" aria-label="${status}"><header>${statusPill(status)}<b>${cards.length}</b></header>${cards.map(item => `
      <article class="board-card${movingItems.has(item.id) ? ' is-saving' : ''}" data-board-item="${item.id}" draggable="${!movingItems.has(item.id)}" aria-busy="${movingItems.has(item.id)}">
        <button type="button" class="board-card-open" data-id="${item.id}" draggable="${!movingItems.has(item.id)}" ${movingItems.has(item.id) ? 'disabled' : ''}><span class="board-meta">${typeIcon(item.type)}<small>${movingItems.has(item.id) ? 'Saving…' : ref(item.id)}</small></span><strong>${esc(item.title)}</strong>${subtaskContext(item)}<span class="board-meta"><small>${esc(item.project)}</small>${item.owner ? avatar(item.owner) : '<small>Unassigned</small>'}</span></button>
        <select class="board-move" data-move-item="${item.id}" ${movingItems.has(item.id) ? 'disabled' : ''} aria-label="Move ${esc(item.title)} to another status">
          ${option('', '', 'Move to…')}${statuses.filter(next => next !== status).map(next => option(next)).join('')}
        </select>
      </article>`).join('') || empty('No items')}</section>`
  }).join('')}</div>`
}
function work() {
  const items = filteredItems()
  return heading(filters.project || (view === 'board' ? 'Work board' : 'All work'),
    `${items.length} ${items.length === 1 ? 'item' : 'items'}${filters.search ? ' matching “' + esc(filters.search) + '”' : ''}`,
    `<button class="button secondary" data-action="export">${icon('download')} Export CSV</button>`) +
    `<div class="work-toolbar">${filterSelect('project', 'All projects', projects())}${filterSelect('status', 'All statuses', statuses)}${filterSelect('type', 'All types', types)}${filterSelect('priority', 'All priorities', priorities)}${filterSelect('owner', 'All assignees', [[':unassigned', 'Unassigned'], ...owners()])}${filters.focus ? `<button class="filter-chip" data-action="clear-focus" aria-label="Clear ${focusLabels[filters.focus]} filter">${focusLabels[filters.focus]}${icon('x')}</button>` : ''}</div>` +
    (view === 'board' ? board(items) : `<section class="panel">${table(items)}</section>`)
}
function activity() {
  return heading('Activity', 'Recent changes, comments, and work logs across the workspace.') +
    `<section class="panel">${workspace.activity.map(event => `<button class="compact-event" data-id="${event.item_id}">${avatar(event.actor)}<div><strong>${esc(event.actor)} · ${esc(event.kind)} · ${esc(event.title)}</strong><small>${ref(event.item_id)} · ${timestamp(event.at)}${event.minutes ? ` · ${event.minutes} min` : ''}</small></div>${icon('chevron')}</button>`).join('') || empty('Updates will appear here as the team tracks work.')}</section>`
}
function teamPage() {
  return heading('Team members', 'Create team logins and reset member passwords.') +
    `<div class="team-layout"><section class="panel"><div class="panel-head"><div><h2>Add a member</h2><p>Share the temporary password privately.</p></div></div>
    <form id="member-form" method="post"><div class="fields">
      <label>Display name<input name="name" maxlength="100" required></label>
      <label>Username<input name="username" minlength="3" maxlength="64" autocomplete="off" required></label>
      <label>Temporary password<input name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" required></label>
    </div><p class="form-error" role="alert"></p><div class="dialog-foot"><button class="button primary">${icon('plus')} Add member</button></div></form></section>
    <section class="panel"><div class="panel-head"><h2>Workspace accounts</h2></div><div id="team-list" class="table-wrap">${teamTable()}</div></section></div>`
}
function teamTable() {
  if (!team) return empty('Loading accounts…')
  return `<table class="work-table"><thead><tr><th>Member</th><th>Role</th><th>Sign-in status</th><th>Action</th></tr></thead><tbody>${team.map(user =>
    `<tr><td class="team-name"><span class="inline-owner">${avatar(user.name)}<span><b>${esc(user.name)}</b><br><small>@${esc(user.username)}</small></span></span></td><td>${user.role === 'admin' ? 'Super admin' : 'Member'}</td><td class="team-status">${user.mustChangePassword ? 'Password change required' : 'Active'}</td><td>${user.role === 'member' ? `<button class="text-button" data-action="reset-member" data-username="${esc(user.username)}">Reset password</button>` : '—'}</td></tr>`).join('')}</tbody></table>`
}
async function loadTeam() {
  try {
    team = await api('/api/users')
    if ($('#team-list')) $('#team-list').innerHTML = teamTable()
  } catch (error) {
    if ($('#team-list')) $('#team-list').innerHTML = empty('Could not load accounts. Reload the page to retry.')
    if (session) notify(error.message)
  }
}
function render() {
  if (!session || $('#workspace').hidden) return
  if (draggedItem) {
    renderAfterDrag = true
    return
  }
  renderNav()
  const main = $('#main')
  if (!workspaceLoaded) {
    main.innerHTML = '<div class="workspace-loading" role="status"><span class="loading-spinner" aria-hidden="true"></span><p>Loading your workspace…</p></div>'
    return
  }
  if (view === 'team' && $('#member-form')) return
  const scrollLeft = main.querySelector('.board')?.scrollLeft || 0
  const focus = document.activeElement
  const focusSelector = focus?.matches('[data-move-item]') ? `[data-move-item="${focus.dataset.moveItem}"]`
    : focus?.matches('.board-card-open') ? `.board-card-open[data-id="${focus.dataset.id}"]` : null
  main.innerHTML = view === 'overview' ? overview() : view === 'activity' ? activity() : view === 'team' ? teamPage() : work()
  if (main.querySelector('.board')) main.querySelector('.board').scrollLeft = scrollLeft
  if (focusSelector) main.querySelector(focusSelector)?.focus({ preventScroll: true })
}
function formField(label, key, value, extras = '') {
  return `<label${key === 'title' ? ' class="wide"' : ''}>${label}<input name="${key}" value="${esc(value)}" ${extras}></label>`
}
function picker(label, key, values, selected) {
  return `<label>${label}<select name="${key}">${values.map(value => option(value, selected)).join('')}</select></label>`
}
function timeline(item) {
  const minutes = item.events.reduce((total, event) => total + event.minutes, 0)
  return `<section class="timeline"><div class="timeline-head"><h3>Discussion & activity</h3><span>${minutes} min logged</span></div>
    <form class="event-form" id="event-form"><div class="event-controls"><label>Update type<select name="kind"><option>Comment</option><option>Work log</option></select></label><label id="minutes-label" hidden>Minutes<input type="number" name="minutes" min="1" max="1440"></label></div>
    <label>Update<textarea name="body" maxlength="10000" required placeholder="Share findings, decisions, or the work you completed"></textarea></label><div><button class="button secondary">Post update</button></div><p class="form-error" role="alert"></p></form>
    ${item.events.map(event => `<article class="event">${avatar(event.actor)}<div><b>${esc(event.actor)} · ${esc(event.kind)}${event.minutes ? ` · ${event.minutes} min` : ''}</b><time datetime="${esc(event.at)}">${timestamp(event.at)}</time><p>${esc(event.body)}</p></div></article>`).join('')}</section>`
}
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + (units[i] || 'MB')
}
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}
function openLightbox(src, filename) {
  const lightbox = $('#image-lightbox')
  if (!lightbox) return
  $('#lightbox-title').textContent = filename
  $('#lightbox-img').src = src
  $('#lightbox-download').href = src
  $('#lightbox-download').download = filename
  staticIcons(lightbox)
  lightbox.showModal()
}

function subtaskContext(item) {
  return item.parent_id ? `<span class="subtask-context">Subtask of ${ref(item.parent_id)}</span>`
    : item.subtask_count ? `<span class="subtask-context">${item.subtask_done || 0}/${item.subtask_count} subtasks completed</span>` : ''
}
function subtaskPanel(item) {
  const children = item.subtasks || []
  const done = children.filter(child => child.status === 'Done').length
  return `<section class="subtasks" id="subtask-panel"><div class="timeline-head"><div><h3>Subtasks</h3><small>${done} of ${children.length} completed</small></div><button type="button" class="button secondary" data-action="add-subtask">${icon('plus')} Add subtask</button></div>
    ${children.length ? `<progress value="${done}" max="${children.length}" aria-label="Subtask completion"></progress>` : '<p class="hint">Break this item into work that can be assigned and tracked separately.</p>'}
    ${children.map(child => {
      const waiting = (child.dependencyIds || []).map(id => children.find(candidate => candidate.id === id)).filter(dependency => dependency && dependency.status !== 'Done')
      return `<button type="button" class="subtask-row" data-action="edit-subtask" data-subtask-id="${child.id}"><span><strong>${ref(child.id)} · ${esc(child.title)}</strong><small>${esc(child.owner || 'Unassigned')}${child.due ? ' · Due ' + shortDate(child.due) : ''}</small>${waiting.length ? `<small class="dependency-wait">Waiting on ${waiting.map(dependency => ref(dependency.id)).join(', ')}</small>` : ''}</span>${statusPill(child.status)}</button>`
    }).join('')}</section>`
}

async function editSubtask(parent, id) {
  const dialog = $('#subtask-dialog')
  try {
    const child = id ? await api(`/api/items/${id}`) : { project: parent.project, type: 'Task', status: 'To do', priority: 'Medium', dependencyIds: [] }
    if (!$('#item-dialog').open || $('#item-dialog').ticket !== parent || dialog.open) return
    const members = [...new Set([...workspace.members, child.owner].filter(Boolean))]
    dialog.innerHTML = `<form id="subtask-form"><div class="dialog-head"><div><h2 id="subtask-title">${id ? 'Edit subtask' : 'New subtask'}</h2><p>Inside ${ref(parent.id)} · ${esc(parent.title)}</p></div><button type="button" class="icon-button" data-action="close" aria-label="Close">${icon('x')}</button></div><div class="fields">
      ${formField('Title', 'title', child.title, 'maxlength="180" required autofocus')}
      <label>Assignee<select name="owner">${option('', child.owner || '', 'Unassigned')}${members.map(name => option(name, child.owner)).join('')}</select></label>
      ${picker('Status', 'status', statuses, child.status)}${picker('Priority', 'priority', priorities, child.priority)}
      ${formField('Due date', 'due', child.due, 'type="date"')}
      <fieldset class="wide subtask-dependencies"><legend>Depends on</legend><p class="hint">Select subtasks that should finish first.</p>${(parent.subtasks || []).filter(candidate => candidate.id !== id).map(candidate => `<label><input type="checkbox" name="dependency" value="${candidate.id}" ${(child.dependencyIds || []).includes(candidate.id) ? 'checked' : ''}>${ref(candidate.id)} · ${esc(candidate.title)}</label>`).join('') || '<small>No other subtasks yet.</small>'}</fieldset>
      <label class="wide">Description<textarea name="description" maxlength="10000">${esc(child.description)}</textarea></label>
      <label class="wide">Resolution<textarea name="resolution" maxlength="10000">${esc(child.resolution)}</textarea></label>
      </div><p class="form-error" role="alert"></p><div class="dialog-foot"><button type="button" class="button secondary" data-action="close">Cancel</button><button class="button primary">${id ? 'Save subtask' : 'Create subtask'}</button></div></form>`
    const form = $('#subtask-form')
    const resolution = () => { form.elements.resolution.required = form.elements.status.value === 'Done' }
    form.elements.status.addEventListener('change', resolution)
    resolution()
    form.addEventListener('submit', async event => {
      event.preventDefault()
      await submit(form, async () => {
        const values = { ...child, ...Object.fromEntries(new FormData(form)), parentId: parent.id,
          dependencyIds: [...form.querySelectorAll('input[name="dependency"]:checked')].map(input => Number(input.value)) }
        delete values.dependency
        const saved = await api(id ? `/api/items/${id}` : '/api/items', id ? 'PATCH' : 'POST', values)
        parent.subtasks = [...(parent.subtasks || []).filter(candidate => candidate.id !== saved.id), saved].sort((a, b) => a.id - b.id)
        if ($('#item-dialog').ticket === parent) $('#subtask-panel').outerHTML = subtaskPanel(parent)
        dialog.close()
        notify(id ? 'Subtask saved' : 'Subtask created')
        await refreshAfterSave()
      })
    })
    dialog.showModal()
  } catch (error) { notify(error.message) }
}

function fillDrawer(item, redraw = false) {
  const dialog = $('#item-dialog')
  dialog.ticket = item
  delete dialog.dataset.loadingRequest
  dialog.removeAttribute('aria-busy')
  dialog.imageListeners?.abort()
  const imageListeners = new AbortController()
  dialog.imageListeners = imageListeners
  const existing = item.id != null
  const savedImages = item.images ? [...item.images] : []
  const draftImages = item._draftImages ? [...item._draftImages] : []
  const removedImageIds = item._removedImageIds ? [...item._removedImageIds] : []
  const imageUrls = new Map()
  const savedImageUrl = image => {
    if (image.size <= 4_000_000) return Promise.resolve(`/api/images/${image.id}`)
    if (!imageUrls.has(image.id)) imageUrls.set(image.id, (async () => {
      const buffers = []
      for (let part = 0; part < Math.ceil(image.size / 524288); part++) {
        const { data } = await api(`/api/images/${image.id}?part=${part}`)
        buffers.push(Uint8Array.from(atob(data), char => char.charCodeAt(0)))
      }
      return URL.createObjectURL(new Blob(buffers, { type: image.mime_type }))
    })())
    return imageUrls.get(image.id)
  }
  const projectChoices = [...new Set([...projects(), ...(existing ? [item.project] : [])])]
  const assigneeChoices = [...new Set([...workspace.members, item.owner].filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
  dialog.innerHTML = `<div class="dialog-head"><div><h2 id="item-dialog-title">${existing ? esc(item.title) : 'New work item'}</h2><p>${existing ? ref(item.id) + ' · ' + esc(item.project) + (item.parent_id ? ' · Subtask of ' + ref(item.parent_id) : '') : 'Track a feature, bug, fix, or task.'}</p></div><button class="icon-button" data-action="close" aria-label="Close">${icon('x')}</button></div>
    <form id="item-form"><div class="fields">
      ${formField('Title', 'title', item.title, 'maxlength="180" required autofocus')}
      <label>Project<select name="project" required><option value="">Select a project</option>${projectChoices.map(name => option(name, item.project)).join('')}</select>
      ${projectChoices.length ? '' : '<small>Ask a super admin to create a project first.</small>'}</label>
      ${picker('Type', 'type', types, item.type || 'Task')}
      <label>Assignee<select name="owner">${option('', item.owner || '', 'Unassigned')}${assigneeChoices.map(name => option(name, item.owner)).join('')}</select></label>
      ${item.parent_id ? '' : formField('Team', 'team', item.team, 'maxlength="100"')}
      ${picker('Status', 'status', statuses, item.status || 'To do')}
      ${picker('Priority', 'priority', priorities, item.priority || 'Medium')}
      ${formField('Due date', 'due', item.due, 'type="date"')}
      <label class="wide">Description<textarea name="description" maxlength="10000" placeholder="Describe the work or the reported behavior">${esc(item.description)}</textarea></label>
      <div class="wide desc-images-container">
        <div class="desc-images-header">
          <span class="desc-images-label">Images in description <small>(Screenshots, mockups, or diagrams)</small></span>
          <label class="button secondary attach-btn">
            ${icon('image')} <span>Attach image</span>
            <input type="file" id="desc-image-input" accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml" multiple hidden>
          </label>
        </div>
        <div class="desc-images-dropzone" id="desc-dropzone">
          <div class="desc-images-list" id="desc-images-list"></div>
          <p class="desc-dropzone-hint" id="desc-dropzone-hint">Paste (Ctrl+V), drag &amp; drop, or choose images to help the assignee understand this issue.</p>
        </div>
      </div>
      <label class="wide">Resolution<textarea name="resolution" maxlength="10000" placeholder="Record what changed and how it was verified">${esc(item.resolution)}</textarea></label>
    </div><p class="form-error" role="alert"></p><div class="dialog-foot"><button type="button" class="button secondary" data-action="close">${existing ? 'Close' : 'Cancel'}</button><button class="button primary">${existing ? 'Save changes' : 'Create item'}</button></div></form>
    ${existing ? subtaskPanel(item) + timeline(item) : ''}`
  const form = $('#item-form')

  const renderImages = () => {
    const listEl = $('#desc-images-list')
    const hintEl = $('#desc-dropzone-hint')
    if (!listEl) return
    const visibleSaved = savedImages.filter(img => !removedImageIds.includes(img.id))
    const total = visibleSaved.length + draftImages.length
    if (hintEl) hintEl.hidden = total > 0
    let html = ''
    visibleSaved.forEach(img => {
      html += `<div class="image-card" data-id="${img.id}">
        <button type="button" class="image-thumb-btn" data-action="view-saved-img" data-id="${img.id}" data-filename="${esc(img.filename)}" title="Click to view full size">
          <img ${img.size <= 4_000_000 ? `src="/api/images/${img.id}"` : `data-large-image="${img.id}"`} alt="${esc(img.filename)}" loading="lazy">
        </button>
        <div class="image-meta">
          <span class="image-filename" title="${esc(img.filename)}">${esc(img.filename)}</span>
          <span class="image-filesize">${formatBytes(img.size)}</span>
        </div>
        <button type="button" class="image-delete-btn" data-action="remove-saved-img" data-id="${img.id}" title="Remove image" aria-label="Remove image">${icon('x')}</button>
      </div>`
    })
    draftImages.forEach((img, idx) => {
      html += `<div class="image-card draft" data-draft-idx="${idx}">
        <button type="button" class="image-thumb-btn" data-action="view-draft-img" data-draft-idx="${idx}" data-filename="${esc(img.filename)}" title="Click to view full size">
          <img src="${img.previewUrl}" alt="${esc(img.filename)}">
        </button>
        <div class="image-meta">
          <span class="image-filename" title="${esc(img.filename)}">${esc(img.filename)}</span>
          <span class="image-filesize">${formatBytes(img.size)}</span>
        </div>
        <button type="button" class="image-delete-btn" data-action="remove-draft-img" data-draft-idx="${idx}" title="Remove image" aria-label="Remove image">${icon('x')}</button>
      </div>`
    })
    listEl.innerHTML = html
    for (const image of visibleSaved.filter(image => image.size > 4_000_000)) {
      const preview = listEl.querySelector(`[data-large-image="${image.id}"]`)
      savedImageUrl(image).then(url => { if (preview.isConnected) preview.src = url }).catch(() => {
        if (preview.isConnected) preview.alt = 'Could not load image. Reopen the incident to retry.'
      })
    }
  }

  const addFiles = async files => {
    const errorEl = form.querySelector('.form-error')
    errorEl.textContent = ''
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue
      if (file.size > 8 * 1024 * 1024) {
        errorEl.textContent = `${file.name} is larger than 8 MB.`
        return
      }
      const count = savedImages.filter(img => !removedImageIds.includes(img.id)).length + draftImages.length
      if (count >= 10) {
        errorEl.textContent = 'Maximum 10 images allowed per work item.'
        return
      }
      try {
        const base64 = await readFileAsBase64(file)
        draftImages.push({
          filename: file.name || `screenshot-${Date.now()}.png`,
          mimeType: file.type || 'image/png',
          size: file.size,
          data: base64,
          previewUrl: URL.createObjectURL(file),
        })
      } catch {
        errorEl.textContent = `Could not read ${file.name}.`
      }
    }
    renderImages()
  }

  renderImages()

  const dropzone = $('#desc-dropzone')
  if (dropzone) {
    dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over') })
    dropzone.addEventListener('dragleave', e => { e.preventDefault(); dropzone.classList.remove('drag-over') })
    dropzone.addEventListener('drop', async e => {
      e.preventDefault()
      dropzone.classList.remove('drag-over')
      const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'))
      if (files.length) await addFiles(files)
    })
  }

  const fileInput = $('#desc-image-input')
  if (fileInput) {
    fileInput.addEventListener('change', async () => {
      const files = Array.from(fileInput.files)
      if (files.length) await addFiles(files)
      fileInput.value = ''
    })
  }

  const pasteListener = async e => {
    const items = e.clipboardData?.items
    if (!items) return
    const files = []
    for (const it of items) {
      if (it.type.startsWith('image/')) {
        const file = it.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length) {
      e.preventDefault()
      await addFiles(files)
    }
  }
  dialog.addEventListener('paste', pasteListener, { signal: imageListeners.signal })

  dialog.addEventListener('click', e => {
    const viewSaved = e.target.closest('[data-action="view-saved-img"]')
    if (viewSaved) {
      const image = savedImages.find(image => image.id === Number(viewSaved.dataset.id))
      if (image) savedImageUrl(image).then(url => {
        if (dialog.open) openLightbox(url, image.filename)
      }).catch(error => notify(error.message))
      return
    }
    const viewDraft = e.target.closest('[data-action="view-draft-img"]')
    if (viewDraft) {
      const img = draftImages[Number(viewDraft.dataset.draftIdx)]
      if (img) openLightbox(img.previewUrl, img.filename)
      return
    }
    const removeSaved = e.target.closest('[data-action="remove-saved-img"]')
    if (removeSaved) {
      removedImageIds.push(Number(removeSaved.dataset.id))
      renderImages()
      return
    }
    const removeDraft = e.target.closest('[data-action="remove-draft-img"]')
    if (removeDraft) {
      const [removed] = draftImages.splice(Number(removeDraft.dataset.draftIdx), 1)
      if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl)
      renderImages()
      return
    }
  }, { signal: imageListeners.signal })

  dialog.addEventListener('close', () => {
    imageListeners.abort()
    for (const promise of imageUrls.values()) promise.then(url => URL.revokeObjectURL(url)).catch(() => {})
    draftImages.forEach(img => { if (img.previewUrl) URL.revokeObjectURL(img.previewUrl) })
  }, { once: true, signal: imageListeners.signal })

  const setResolution = () => { form.elements.resolution.required = form.elements.status.value === 'Done' }
  form.elements.status.addEventListener('change', setResolution)
  setResolution()
  form.addEventListener('submit', async event => {
    event.preventDefault()
    const values = Object.fromEntries(new FormData(form))
    if (existing) {
      if (item.parent_id) values.team = item.team || ''
      values.version = item.version
      if (removedImageIds.length) {
        values.removedImageIds = removedImageIds
      }
    }
    await submit(form, async () => {
      const updateForm = $('#event-form')
      if (existing && updateForm?.elements.body.value.trim()) {
        if (!updateForm.reportValidity()) return
        values.update = Object.fromEntries(new FormData(updateForm))
        values.update.minutes = Number(values.update.minutes)
      }
      const saveButton = form.querySelector('button:not([type])')
      const label = saveButton.textContent
      try {
        if (draftImages.length) {
          const uploaded = await uploadImages(draftImages, progress => { saveButton.textContent = progress })
          values[existing ? 'newImages' : 'images'] = uploaded
        }
        saveButton.textContent = 'Saving…'
        const saved = await api(existing ? `/api/items/${item.id}` : '/api/items', existing ? 'PATCH' : 'POST', values)
        if (form.isConnected && dialog.open) dialog.close()
        notify(existing ? 'Work item saved' : `${ref(saved.id)} created`)
        await refreshAfterSave()
      } finally { saveButton.textContent = label }
    })
  })
  const eventForm = $('#event-form')
  if (eventForm) {
    eventForm.elements.kind.addEventListener('change', () => {
      const isLog = eventForm.elements.kind.value === 'Work log'
      $('#minutes-label').hidden = !isLog
      eventForm.elements.minutes.required = isLog
    })
    eventForm.addEventListener('submit', async event => {
      event.preventDefault()
      await submit(eventForm, async () => {
        const values = Object.fromEntries(new FormData(eventForm))
        values.minutes = Number(values.minutes)
        const saved = await api(`/api/items/${item.id}/events`, 'POST', values)
        if (dialog.open && form.isConnected) {
          const draft = Object.fromEntries(new FormData(form))
          fillDrawer({ ...item, events: saved.events, images: savedImages, _draftImages: draftImages, _removedImageIds: removedImageIds }, true)
          for (const [key, value] of Object.entries(draft)) $('#item-form').elements[key].value = value
          $('#item-form').elements.status.dispatchEvent(new Event('change'))
          $('#event-form').elements.body.focus()
        }
        notify('Update posted')
        await refreshAfterSave()
      })
    })
  }
  if (!redraw) dialog.showModal()
}
async function submit(form, task) {
  const otherForm = form.id === 'item-form' ? $('#event-form') : form.id === 'event-form' ? $('#item-form') : null
  if (otherForm?.querySelector('button:not([type]), button[type="submit"]')?.disabled) return
  const button = form.querySelector('button:not([type]), button[type="submit"]')
  const otherButton = otherForm?.querySelector('button:not([type]), button[type="submit"]')
  const error = form.querySelector('.form-error')
  button.disabled = true
  if (otherButton) otherButton.disabled = true
  error.textContent = ''
  try { await task() } catch (failure) { error.textContent = failure.message }
  finally {
    button.disabled = false
    if (otherButton) otherButton.disabled = false
  }
}
function download(name, csv) {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }))
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 1000)
}
const headers = ['Title', 'Type', 'Project', 'Owner', 'Status', 'Priority', 'Due', 'Description', 'Resolution']
function setMenu(open) {
  $('.sidebar').classList.toggle('open', open)
  $('#menu').setAttribute('aria-expanded', String(open))
  if (open) $('.brand').focus()
}

async function moveBoardItem(item, status) {
  if (!item || status === item.status || movingItems.has(item.id)) return
  const before = { ...item }
  const account = session
  movingItems.add(item.id)
  workspaceRequest++
  clearTimeout(boardRefreshTimer)
  let optimistic = false
  let conflict = false
  try {
    if (status === 'Done' && !item.resolution.trim()) {
      const detail = await api(`/api/items/${item.id}`)
      if (view !== 'board' || document.querySelector('dialog[open]')) return
      fillDrawer({ ...detail, status: 'Done' })
      $('#item-form').elements.resolution.focus()
      return
    }
    Object.assign(item, { status, updated: new Date().toISOString() })
    optimistic = true
    render()
    const saved = await api(`/api/items/${item.id}/status?summary=1`, 'PATCH', { status, version: before.version })
    if (session !== account) return
    Object.assign(item, saved)
    lastWorkspace = ''
    notify(`${ref(item.id)} moved to ${status}`)
  } catch (error) {
    if (session !== account) return
    if (optimistic) Object.assign(item, before)
    conflict = error.status === 409
    notify(error.message)
  } finally {
    movingItems.delete(item.id)
    workspaceRequest++
    if (session === account) {
      if (optimistic) render()
      clearTimeout(boardRefreshTimer)
      boardRefreshTimer = setTimeout(() => {
        if (session === account) void refresh().catch(() => {})
      }, conflict ? 0 : 800)
    }
  }
}

const clearDropTarget = () => $('.board-col.is-drop-target')?.classList.remove('is-drop-target')
function endBoardDrag() {
  if (draggedItem) suppressBoardClick = true
  draggedItem = undefined
  $('.board-card.is-dragging')?.classList.remove('is-dragging')
  clearDropTarget()
  if (renderAfterDrag) {
    renderAfterDrag = false
    render()
  }
}

const main = $('#main')
main.addEventListener('pointerdown', () => { suppressBoardClick = false }, { capture: true })
main.addEventListener('keydown', () => { suppressBoardClick = false }, { capture: true })
main.addEventListener('click', event => {
  // Some browsers dispatch a click on the card after a drag releases the pointer.
  if (!suppressBoardClick || event.detail === 0 || !event.target.closest('.board')) return
  event.preventDefault()
  event.stopImmediatePropagation()
}, { capture: true })
main.addEventListener('dragstart', event => {
  const card = event.target.closest('.board-card')
  if (!card || movingItems.has(Number(card.dataset.boardItem)) || event.target.closest('select')) {
    event.preventDefault()
    return
  }
  draggedItem = workspace.items.find(item => item.id === Number(card.dataset.boardItem))
  if (!draggedItem) return
  suppressBoardClick = true
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('text/plain', ref(draggedItem.id))
  card.classList.add('is-dragging')
})
main.addEventListener('dragover', event => {
  if (!draggedItem) return
  const column = event.target.closest('.board-col')
  if (column?.classList.contains('is-drop-target')) { event.preventDefault(); return }
  clearDropTarget()
  if (!column || column.dataset.boardStatus === draggedItem.status) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  column.classList.add('is-drop-target')
})
main.addEventListener('dragleave', event => {
  const column = event.target.closest('.board-col')
  if (column && !column.contains(event.relatedTarget)) column.classList.remove('is-drop-target')
})
main.addEventListener('dragend', endBoardDrag)
main.addEventListener('drop', event => {
  const column = event.target.closest('.board-col')
  if (!column || !draggedItem) return
  event.preventDefault()
  event.stopPropagation()
  suppressBoardClick = true
  const item = draggedItem
  endBoardDrag()
  void moveBoardItem(item, column.dataset.boardStatus)
})

document.addEventListener('click', async event => {
  const button = event.target.closest('button')
  if ($('.sidebar').classList.contains('open') && !event.target.closest('.sidebar') && button?.id !== 'menu') setMenu(false)
  if (!button) return
  if (button.id === 'menu') return setMenu(!$('.sidebar').classList.contains('open'))
  if (button.dataset.view) { setMenu(false); return routeTo(button.dataset.view) }
  if ('project' in button.dataset) { setMenu(false); return routeTo('work', { project: button.dataset.project }) }
  if (button.dataset.id) {
    const request = ++openRequest
    const dialog = $('#item-dialog')
    if (dialog.open) return
    dialog.dataset.loadingRequest = String(request)
    dialog.setAttribute('aria-busy', 'true')
    dialog.innerHTML = `<div class="dialog-head"><h2 id="item-dialog-title">Loading incident…</h2><button type="button" class="icon-button" data-action="close" aria-label="Close">${icon('x')}</button></div><p class="loading" role="status">Loading details and discussion…</p>`
    dialog.showModal()
    try {
      const item = await api(`/api/items/${button.dataset.id}`)
      if (request === openRequest && dialog.open && dialog.dataset.loadingRequest === String(request)) fillDrawer(item, true)
    } catch (error) {
      if (dialog.dataset.loadingRequest === String(request)) {
        dialog.close()
        delete dialog.dataset.loadingRequest
        dialog.removeAttribute('aria-busy')
      }
      notify(error.message)
    }
    return
  }
  switch (button.dataset.action) {
    case 'add-subtask': return editSubtask($('#item-dialog').ticket)
    case 'edit-subtask': return editSubtask($('#item-dialog').ticket, Number(button.dataset.subtaskId))
    case 'retry-workspace':
      button.disabled = true
      try { await refresh() } catch (error) { notify(error.message) }
      finally { button.disabled = false }
      return
    case 'focus': return routeTo('work', { focus: button.dataset.focus })
    case 'clear-focus': return routeTo(view, { ...filters, focus: '' })
    case 'create': return fillDrawer({ project: filters.project })
    case 'new-project': {
      const form = $('#project-form')
      form.reset()
      form.querySelector('.form-error').textContent = ''
      return $('#project-dialog').showModal()
    }
    case 'close': return button.closest('dialog').close()
    case 'import':
      setMenu(false)
      $('#import-form').reset()
      $('#import-error').textContent = ''
      return $('#import-dialog').showModal()
    case 'password': return showAccount(session, true)
    case 'cancel-password': return showAccount(session)
    case 'logout':
      button.disabled = true
      try { await api('/api/session', 'DELETE', {}); showAccount() }
      catch (error) { notify(error.message) }
      finally { button.disabled = false }
      return
    case 'reset-member': {
      const form = $('#reset-form')
      form.reset()
      form.querySelector('.form-error').textContent = ''
      form.dataset.username = button.dataset.username
      $('#reset-context').textContent = `@${form.dataset.username} will sign in again with the temporary password.`
      return $('#reset-dialog').showModal()
    }
    case 'template': return download('trackline-template.csv', encodeCSV([headers]))
    case 'export': return download('trackline-work-items.csv', encodeCSV([headers, ...filteredItems().map(item => fields.map(key => item[key]))]))
  }
})
document.addEventListener('change', event => {
  if (event.target.dataset.filter) routeTo(view, { ...filters, [event.target.dataset.filter]: event.target.value })
  if (event.target.dataset.moveItem && event.target.value) {
    const select = event.target
    const status = select.value
    select.value = ''
    void moveBoardItem(workspace.items.find(item => item.id === Number(select.dataset.moveItem)), status)
  }
})
$('#project-form').addEventListener('submit', event => {
  event.preventDefault()
  const form = event.currentTarget
  void submit(form, async () => {
    const { name } = await api('/api/projects', 'POST', Object.fromEntries(new FormData(form)))
    $('#project-dialog').close()
    notify(`Created project “${name}”`)
    await refreshAfterSave()
  })
})
$('#search').addEventListener('input', event => {
  const next = ['work', 'board'].includes(view) ? view : 'work'
  routeTo(next, { ...filters, search: event.target.value }, next === view)
})
$('#import-form').addEventListener('submit', event => {
  event.preventDefault()
  submit(event.currentTarget, async () => {
    const file = $('#csv-file').files[0]
    if (file.size > 1_800_000) throw new Error('Choose a CSV under 1.8 MB or split it into smaller files.')
    const rows = parseImport(await file.text())
    const { count } = await api('/api/import', 'POST', rows)
    $('#import-dialog').close()
    routeTo('work')
    notify(`Imported ${count} ${count === 1 ? 'item' : 'items'}`)
    await refreshAfterSave()
  })
})
$('#login-form').addEventListener('submit', event => {
  event.preventDefault()
  const form = event.currentTarget
  submit(form, async () => showAccount(await api('/api/session', 'POST', Object.fromEntries(new FormData(form)))))
})
$('#password-form').addEventListener('submit', event => {
  event.preventDefault()
  const form = event.currentTarget
  submit(form, async () => {
    const { currentPassword, password, confirmation } = Object.fromEntries(new FormData(form))
    if (password !== confirmation) throw new Error('The new passwords do not match.')
    showAccount(await api('/api/password', 'POST', { currentPassword, password }))
    notify('Password updated')
  })
})
document.addEventListener('submit', event => {
  const form = event.target
  if (form.id !== 'member-form' && form.id !== 'reset-form') return
  event.preventDefault()
  submit(form, async () => {
    const values = Object.fromEntries(new FormData(form))
    if (form.id === 'member-form') {
      const member = await api('/api/users', 'POST', values)
      notify(`Account created for @${member.username}`)
      refreshAfterSave()
    } else {
      await api(`/api/users/${encodeURIComponent(form.dataset.username)}/password`, 'POST', { password: values.password })
      if ($('#reset-dialog').open) $('#reset-dialog').close()
      notify('Temporary password set')
    }
    form.reset()
    await loadTeam()
  })
})
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('.sidebar').classList.contains('open')) { setMenu(false); $('#menu').focus() }
  if (event.key === '/' && session && !$('#workspace').hidden && !document.querySelector('dialog[open]') && !event.target.closest('input, textarea, select, [contenteditable]')) {
    event.preventDefault()
    $('#search').focus()
  }
})
window.addEventListener('popstate', readRoute)
window.addEventListener('hashchange', readRoute)
staticIcons()
api('/api/session').then(showAccount).catch(error => {
  if (error.status === 401) showAccount()
  else $('#auth-status').textContent = error.message || 'Unable to reach Trackline. Reload the page to try again.'
})
setInterval(() => {
  if (session && !$('#workspace').hidden && !document.hidden) {
    refresh().catch(() => {})
    if (view === 'team') loadTeam()
  }
}, 30000)
