import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  compareVersions,
  copyName,
  extractScriptId,
  versionFromName,
} from '../src/shared/naming.ts'

test('copyName / versionFromName round-trip', () => {
  assert.equal(copyName('6.03'), 'Offline RogueDex 6.03')
  assert.equal(versionFromName('Offline RogueDex 6.03'), '6.03')
  assert.equal(versionFromName('PUBLIC_Offline RogueDex 6.03'), '6.03')
  assert.equal(versionFromName('Offline RogueDex 6.03 test'), '6.03')
  assert.equal(versionFromName('Offline RogueDex'), null)
})

test('compareVersions is numeric, not lexical', () => {
  assert.ok(compareVersions('6.10', '6.9') > 0)
  assert.ok(compareVersions('6.03', '6.10') < 0)
  assert.equal(compareVersions('6.03', '6.03'), 0)
  assert.ok(compareVersions('7.0', '6.99') > 0)
})

test('extractScriptId accepts ids, editor URLs and query params', () => {
  const id = '1vPLtrHsiTIjUsLLjNJoWY968IlnmtjJoVsJES9c3BCPaSKg0-Dwz3UyH'
  assert.equal(extractScriptId(id), id)
  assert.equal(
    extractScriptId(`https://script.google.com/home/projects/${id}/edit`),
    id,
  )
  assert.equal(
    extractScriptId(`https://script.google.com/d/x?scriptId=${id}`),
    id,
  )
  assert.equal(extractScriptId('not an id'), null)
})
