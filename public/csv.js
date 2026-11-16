const aliases = new Map(Object.entries({
  title: 'title', summary: 'title', subject: 'title', project: 'project', type: 'type',
  owner: 'owner', assignee: 'owner', status: 'status', priority: 'priority',
  due: 'due', duedate: 'due', description: 'description', details: 'description',
  resolution: 'resolution', solution: 'resolution',
}))

export function parseImport(text) {
  const rows = []
  let row = [], field = '', quoted = false, closed = false
  const endField = () => { row.push(field.trim()); field = ''; closed = false }
  const endRow = () => { endField(); if (row.some(Boolean)) rows.push(row); row = [] }
  text = text.replace(/^\uFEFF/, '')
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quoted) {
      if (char !== '"') field += char
      else if (text[index + 1] === '"') { field += '"'; index++ }
      else { quoted = false; closed = true }
    } else if (char === ',') endField()
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++
      endRow()
    } else if (char === '"' && !field.trim() && !closed) { field = ''; quoted = true }
    else if (char === '"' || (closed && char.trim())) throw new Error('CSV contains an unexpected character after or within a quoted field.')
    else field += char
  }
  if (quoted) throw new Error('A quoted CSV field is missing its closing quote.')
  endRow()
  const headers = rows.shift()?.map(value => aliases.get(value.toLowerCase().replace(/[^a-z]/g, '')))
  if (!headers?.includes('title') || !headers.includes('project')) throw new Error('The CSV needs Title and Project columns.')
  const mapped = headers.filter(Boolean)
  if (new Set(mapped).size !== mapped.length) throw new Error('Two CSV columns map to the same field.')
  if (!rows.length) throw new Error('The CSV does not contain any work items.')
  const choices = { type: ['Feature', 'Bug', 'Fix', 'Task'], status: ['To do', 'In progress', 'Blocked', 'In review', 'Done'], priority: ['Low', 'Medium', 'High', 'Urgent'] }
  return rows.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`Record ${index + 1} has a different number of fields than the header.`)
    return Object.fromEntries(headers.flatMap((key, column) => {
      if (!key) return []
      const value = values[column]
      return [[key, choices[key]?.find(choice => choice.toLowerCase() === value.toLowerCase()) ?? value]]
    }))
  })
}

export function encodeCSV(rows) {
  return rows.map(row => row.map(value => {
    let string = String(value ?? '')
    if (/^[\s\uFEFF]*[=+@-]/.test(string)) string = "'" + string
    return '"' + string.replaceAll('"', '""') + '"'
  }).join(',')).join('\r\n')
}
