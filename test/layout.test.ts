import assert from 'node:assert/strict'
import { test } from 'node:test'
import './fake-gas.ts'
import { HEADERS, LAYOUT_603 } from './fixtures.ts'
import {
  columnLetter,
  describeResolved,
  findLabel,
  resolveFromBands,
} from '../src/lib/layout.ts'
import { TRACKER_SPECS } from '../src/lib/saveTracker.ts'

const spec = (key: string) => TRACKER_SPECS.find((s) => s.key === key)!

test('findLabel is case/space-insensitive and 1-based', () => {
  const band = [
    ['', 'Foo  Bar'],
    ['x', 'baz'],
  ]
  assert.deepEqual(findLabel(band, 'foo bar'), { row: 1, col: 2 })
  assert.deepEqual(findLabel(band, 'BAZ'), { row: 2, col: 2 })
  assert.equal(findLabel(band, 'nope'), null)
})

test('Quick Checklist resolves on the migrated 6.03 header (labels replaced by stats)', () => {
  const r = resolveFromBands(
    spec('QuickChecklist'),
    HEADERS['STARTER_CHECKLIST.data']!,
    HEADERS['Quick Checklist (migrated)']!,
  )
  assert.equal(r.shift, 4)
  assert.equal(r.minDataCol, LAYOUT_603.quick.dataShinyCol)
  assert.equal(r.maxDataCol, LAYOUT_603.quick.dataMaxIvsCol)
  assert.equal(r.minDisplayCol, LAYOUT_603.quick.displayShinyCol)
  assert.equal(r.maxDisplayCol, LAYOUT_603.quick.displayMaxIvsCol)
  assert.equal(r.cells.length, 8)
  assert.ok(r.cells.every((c) => c.color === '#ffff00'))
})

test('Quick Checklist resolves identically on the fresh PUBLIC 6.03 header', () => {
  const r = resolveFromBands(
    spec('QuickChecklist'),
    HEADERS['STARTER_CHECKLIST.data']!,
    HEADERS['Quick Checklist (fresh PUBLIC)']!,
  )
  assert.equal(r.shift, 4)
  assert.equal(r.minDisplayCol, 8)
})

test('Quick Checklist on the 6.01 layout (no junk column E) resolves to shift +3', () => {
  const display601 = HEADERS['Quick Checklist (fresh PUBLIC)']!.map((row) => [
    ...row.slice(0, 4),
    ...row.slice(5),
  ])
  const r = resolveFromBands(
    spec('QuickChecklist'),
    HEADERS['STARTER_CHECKLIST.data']!,
    display601,
  )
  assert.equal(r.shift, 3)
  assert.equal(r.minDisplayCol, 7)
})

test('dex sheets resolve to the known 6.03 shifts with named exclude/increment columns', () => {
  const s = resolveFromBands(
    spec('StarterDex'),
    HEADERS['STARTER_DEX.data']!,
    HEADERS['Starter Dex Checklist']!,
  )
  assert.equal(s.shift, -8)
  assert.equal(s.minDataCol, 12)
  assert.equal(s.maxDataCol, 143)
  assert.equal(s.minDisplayCol, 4)
  assert.equal(s.maxDisplayCol, 135)
  const byDisplay = Object.fromEntries(
    s.cells.map((c) => [c.displayCol, c.color]),
  )
  assert.equal(byDisplay[5], null, 'E Fought Count excluded')
  assert.equal(byDisplay[34], null, 'AH Candy Count excluded')
  assert.equal(byDisplay[35], null, 'AI Friendship excluded')
  assert.equal(byDisplay[14], '#b4a7d6', 'N Caught Count increment')
  assert.equal(byDisplay[28], '#b4a7d6', 'AB Hatched Count increment')
  assert.equal(byDisplay[41], '#b4a7d6', 'AO Classic Wins increment')
  assert.equal(byDisplay[4], '#93c47d')

  const f = resolveFromBands(
    spec('FullDex'),
    HEADERS['FULL_DEX.data']!,
    HEADERS['Full Dex Checklist']!,
  )
  assert.equal(f.shift, -4)
  assert.equal(f.minDataCol, 8)
  assert.equal(f.maxDataCol, 139)
  assert.equal(f.maxDisplayCol, 135)
})

test('a creator column insert in the display is absorbed; a renamed anchor fails loudly', () => {
  const display = HEADERS['Starter Dex Checklist']!.map((row) => [
    ...row.slice(0, 3),
    'NEW',
    ...row.slice(3),
  ])
  const r = resolveFromBands(
    spec('StarterDex'),
    HEADERS['STARTER_DEX.data']!,
    display,
  )
  assert.equal(r.shift, -7)

  const renamed = HEADERS['STARTER_DEX.data']!.map((row) =>
    row.map((c) => (c === 'Fought Flag' ? 'Seen Flag' : c)),
  )
  assert.throws(
    () =>
      resolveFromBands(
        spec('StarterDex'),
        renamed,
        HEADERS['Starter Dex Checklist']!,
      ),
    /could not find the header "Fought Flag"/,
  )
})

test('cross-check catches a display that only partly moved', () => {
  // Insert a column in the display AFTER Fought Flag but before Classic Wins: shift no longer uniform.
  const display = HEADERS['Starter Dex Checklist']!.map((row) => [
    ...row.slice(0, 10),
    'NEW',
    ...row.slice(10),
  ])
  assert.throws(
    () =>
      resolveFromBands(
        spec('StarterDex'),
        HEADERS['STARTER_DEX.data']!,
        display,
      ),
    /"Classic Wins" is at column/,
  )
})

test('describeResolved is readable', () => {
  const r = resolveFromBands(
    spec('QuickChecklist'),
    HEADERS['STARTER_CHECKLIST.data']!,
    HEADERS['Quick Checklist (migrated)']!,
  )
  assert.equal(
    describeResolved(r),
    'QuickChecklist: data D–K (SHINY … Max IVs) → display H–O (shift +4)',
  )
  assert.equal(columnLetter(136), 'EF')
})
