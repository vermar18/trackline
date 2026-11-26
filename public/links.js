const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

// Render plain text only. User HTML is never interpreted and links use HTTP(S).
export function linkedText(value) {
  const text = String(value ?? '')
  const pattern = /https?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+/gi
  let html = ''
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    let label = match[0].replace(/[.,!?;:]+$/, '')
    // Keep balanced URL parentheses, but leave surrounding prose punctuation out.
    while (/[)\]}]$/.test(label)) {
      const closing = label.at(-1)
      const opening = { ')': '(', ']': '[', '}': '{' }[closing]
      if (label.split(closing).length <= label.split(opening).length) break
      label = label.slice(0, -1).replace(/[.,!?;:]+$/, '')
    }
    html += escapeHTML(text.slice(cursor, match.index))
    try {
      const url = new URL(/^www\./i.test(label) ? 'https://' + label : label)
      if (!['https:', 'http:'].includes(url.protocol) || !url.hostname) throw new Error('Unsupported link')
      html += `<a href="${escapeHTML(url.href)}" target="_blank" rel="noopener noreferrer">${escapeHTML(label)}</a>`
    } catch { html += escapeHTML(label) }
    cursor = match.index + label.length
  }
  return html + escapeHTML(text.slice(cursor))
}

export function bindLinkPreviews(root) {
  for (const input of root.querySelectorAll('textarea[name="description"], textarea[name="body"]')) {
    const preview = document.createElement('div')
    preview.className = 'wide link-preview'
    input.closest('label').after(preview)
    const update = () => {
      const html = linkedText(input.value)
      preview.hidden = !html.includes('<a ')
      preview.innerHTML = preview.hidden ? '' : `<small>Preview · links open in a new tab</small><div class="linked-text">${html}</div>`
    }
    input.addEventListener('input', update)
    update()
  }
}
