import assert from 'node:assert/strict'
import test from 'node:test'
import { linkedText } from './public/links.js'

test('links support HTTP, HTTPS and www addresses with safe new tabs', () => {
  const html = linkedText('See https://example.com/ticket?a=1&b=2, http://localhost:4173 and www.example.com/docs.')
  assert.match(html, /href="https:\/\/example.com\/ticket\?a=1&amp;b=2"/)
  assert.match(html, /href="http:\/\/localhost:4173\/"/)
  assert.match(html, /href="https:\/\/www.example.com\/docs"/)
  assert.equal((html.match(/rel="noopener noreferrer"/g) || []).length, 3)
  assert.match(html, /docs<\/a>\.$/)
})

test('URL punctuation preserves balanced parentheses and surrounding text', () => {
  assert.equal(linkedText('(https://example.com/wiki/Function_(math)). Next'),
    '(<a href="https://example.com/wiki/Function_(math)" target="_blank" rel="noopener noreferrer">https://example.com/wiki/Function_(math)</a>). Next')
  assert.match(linkedText('https://example.com/a! https://example.org/b?'), /a<\/a>! <a href=/)
  assert.equal(linkedText('Line 1\nLine 2'), 'Line 1\nLine 2')
})

test('user HTML, attribute injection and executable protocols stay inert', () => {
  const html = linkedText('<img src=x onerror="alert(1)"> https://example.com/" onclick="alert(1)\n<script>alert(2)</script>')
  assert.ok(!html.includes('<img'))
  assert.ok(!html.includes('<script'))
  assert.ok(!html.includes('" onclick="'))
  assert.match(html, /&lt;img/)
  assert.equal(linkedText('javascript:alert(1) data:text/html,test file:///tmp/test'), 'javascript:alert(1) data:text/html,test file:///tmp/test')
  assert.equal(linkedText('Broken https:// and https://[invalid]'), 'Broken https:// and https://[invalid]')
  assert.equal(linkedText(null), '')
})
