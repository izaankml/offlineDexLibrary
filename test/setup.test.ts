import assert from 'node:assert/strict'
import { test } from 'node:test'
import './fake-gas.ts'
import { newestVersionBelow, prepareDialogHtml } from '../src/lib/setup.ts'

test('newestVersionBelow ignores PUBLIC_, test copies and newer versions', () => {
  const names = [
    'PUBLIC_Offline RogueDex 6.03',
    'Offline RogueDex 6.01',
    'Offline RogueDex 5.9',
    'Offline RogueDex 6.03',
    'Offline RogueDex 6.03 test',
    'Offline RogueDex 6.10',
  ]
  assert.equal(newestVersionBelow(names, '6.03'), '6.01')
  assert.equal(newestVersionBelow(names, '6.10'), '6.03')
  assert.equal(newestVersionBelow(names, '5.0'), null)
})

test('prepare dialog escapes and embeds the copy link', () => {
  const html = prepareDialogHtml({ copyName: 'A & B', copyUrl: 'https://x/"y"', version: '6.03' })
  assert.ok(html.includes('Copy ready: A &amp; B'))
  assert.ok(html.includes('href="https://x/&quot;y&quot;"'))
})
