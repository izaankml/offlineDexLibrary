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

const spec = (key: string) =>
  TRACKER_SPECS.find((candidate) => candidate.key === key)!

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
  const resolved = resolveFromBands(
    spec('QuickChecklist'),
    HEADERS['STARTER_CHECKLIST.data']!,
    HEADERS['Quick Checklist (migrated)']!,
  )
  assert.equal(resolved.shift, 4)
  assert.equal(resolved.minDataCol, LAYOUT_603.quick.dataShinyCol)
  assert.equal(resolved.maxDataCol, LAYOUT_603.quick.dataMaxIvsCol)
  assert.equal(resolved.minDisplayCol, LAYOUT_603.quick.displayShinyCol)
  assert.equal(resolved.maxDisplayCol, LAYOUT_603.quick.displayMaxIvsCol)
  assert.equal(resolved.cells.length, 8)
  assert.ok(resolved.cells.every((cell) => cell.color === '#ffff00'))
})

test('Quick Checklist resolves identically on the fresh PUBLIC 6.03 header', () => {
  const resolved = resolveFromBands(
    spec('QuickChecklist'),
    HEADERS['STARTER_CHECKLIST.data']!,
    HEADERS['Quick Checklist (fresh PUBLIC)']!,
  )
  assert.equal(resolved.shift, 4)
  assert.equal(resolved.minDisplayCol, 8)
})

test('Quick Checklist on the 6.01 layout (no junk column E) resolves to shift +3', () => {
  const display601 = HEADERS['Quick Checklist (fresh PUBLIC)']!.map((row) => [
    ...row.slice(0, 4),
    ...row.slice(5),
  ])
  const resolved = resolveFromBands(
    spec('QuickChecklist'),
    HEADERS['STARTER_CHECKLIST.data']!,
    display601,
  )
  assert.equal(resolved.shift, 3)
  assert.equal(resolved.minDisplayCol, 7)
})

test('dex sheets resolve to the known 6.03 shifts with named exclude/increment columns', () => {
  const starter = resolveFromBands(
    spec('StarterDex'),
    HEADERS['STARTER_DEX.data']!,
    HEADERS['Starter DEX Checklist']!,
  )
  assert.equal(starter.shift, -8)
  assert.equal(starter.minDataCol, 12)
  assert.equal(starter.maxDataCol, 143)
  assert.equal(starter.minDisplayCol, 4)
  assert.equal(starter.maxDisplayCol, 135)
  const colorByDisplayCol = Object.fromEntries(
    starter.cells.map((cell) => [cell.displayCol, cell.color]),
  )
  assert.equal(colorByDisplayCol[5], null, 'E Fought Count excluded')
  assert.equal(colorByDisplayCol[34], null, 'AH Candy Count excluded')
  assert.equal(colorByDisplayCol[35], null, 'AI Friendship excluded')
  assert.equal(colorByDisplayCol[14], '#b4a7d6', 'N Caught Count increment')
  assert.equal(colorByDisplayCol[28], '#b4a7d6', 'AB Hatched Count increment')
  assert.equal(
    colorByDisplayCol[33],
    '#b4a7d6',
    'AG Total (Egg Move Attributes) increment',
  )
  assert.equal(colorByDisplayCol[41], '#b4a7d6', 'AO Classic Wins increment')
  assert.equal(colorByDisplayCol[4], '#93c47d')

  const full = resolveFromBands(
    spec('FullDex'),
    HEADERS['FULL_DEX.data']!,
    HEADERS['Full DEX Checklist']!,
  )
  assert.equal(full.shift, -4)
  assert.equal(full.minDataCol, 8)
  assert.equal(full.maxDataCol, 139)
  assert.equal(full.maxDisplayCol, 135)
  const fullColorByDisplayCol = Object.fromEntries(
    full.cells.map((cell) => [cell.displayCol, cell.color]),
  )
  assert.equal(
    fullColorByDisplayCol[33],
    '#b4a7d6',
    'AG Total (Egg Move Attributes) increment',
  )
})

test('a creator column insert in the display is absorbed; a renamed anchor fails loudly', () => {
  const display = HEADERS['Starter DEX Checklist']!.map((row) => [
    ...row.slice(0, 3),
    'NEW',
    ...row.slice(3),
  ])
  const resolved = resolveFromBands(
    spec('StarterDex'),
    HEADERS['STARTER_DEX.data']!,
    display,
  )
  assert.equal(resolved.shift, -7)

  const renamed = HEADERS['STARTER_DEX.data']!.map((row) =>
    row.map((label) => (label === 'Fought Flag' ? 'Seen Flag' : label)),
  )
  assert.throws(
    () =>
      resolveFromBands(
        spec('StarterDex'),
        renamed,
        HEADERS['Starter DEX Checklist']!,
      ),
    /could not find the header "Fought Flag"/,
  )
})

test('cross-check catches a display that only partly moved', () => {
  // Insert a column in the display AFTER Fought Flag but before Classic Wins: shift no longer uniform.
  const display = HEADERS['Starter DEX Checklist']!.map((row) => [
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
  const resolved = resolveFromBands(
    spec('QuickChecklist'),
    HEADERS['STARTER_CHECKLIST.data']!,
    HEADERS['Quick Checklist (migrated)']!,
  )
  assert.equal(
    describeResolved(resolved),
    'QuickChecklist: data D–K (SHINY … Max IVs) → display H–O (shift +4)',
  )
  assert.equal(columnLetter(136), 'EF')
})
