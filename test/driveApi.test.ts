import assert from 'node:assert/strict'
import { test } from 'node:test'
import { driveFilePages, driveListCalls, resetFakes } from './fake-gas.ts'
import { driveQueryString, listSpreadsheets } from '../src/lib/driveApi.ts'
import { findFileIdByVersion } from '../src/lib/migrator.ts'
import { detectPreviousVersion } from '../src/lib/setup.ts'

test('listSpreadsheets follows nextPageToken and scopes the query to spreadsheets', () => {
  resetFakes()
  driveFilePages.push(
    [{ name: 'first' }, { name: 'second' }],
    [{ name: 'third' }],
  )
  const names = listSpreadsheets("name = 'x'").map((file) => file.name)
  assert.deepEqual(names, ['first', 'second', 'third'])
  assert.equal(driveListCalls.length, 2)
  assert.equal(driveListCalls[1]!.pageToken, '1')
  assert.equal(
    driveListCalls[0]!.q,
    "name = 'x' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
  )
})

test('driveQueryString escapes quotes and backslashes', () => {
  assert.equal(driveQueryString("it's"), "'it\\'s'")
  assert.equal(driveQueryString('a\\b'), "'a\\\\b'")
})

test('findFileIdByVersion picks the most recently modified same-named copy', () => {
  resetFakes()
  driveFilePages.push([
    { id: 'older', modifiedTime: '2026-09-01T10:00:00.000Z' },
    { id: 'newer', modifiedTime: '2026-10-01T10:00:00.000Z' },
  ])
  assert.equal(findFileIdByVersion('6.04'), 'newer')
  assert.equal(
    driveListCalls[0]!.q.startsWith("name = 'Offline RogueDex 6.04' and "),
    true,
  )
})

test('detectPreviousVersion reads names from the Drive listing', () => {
  resetFakes()
  driveFilePages.push([
    { name: 'PUBLIC_Offline RogueDex 6.05' },
    { name: 'Offline RogueDex 6.03' },
    { name: 'Offline RogueDex 6.04' },
  ])
  assert.equal(detectPreviousVersion('6.05'), '6.04')
})
