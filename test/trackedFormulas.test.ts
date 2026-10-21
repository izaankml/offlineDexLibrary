import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DAILY_UNLOCKS_AG3_FORMULA,
  UNLOCK_MAP_FORMULA_COLUMNS,
  normalizeFormula,
  sameFormula,
  unlockMapColumnFormula,
} from '../src/lib/trackedFormulas.ts'

/** Parentheses balance outside string literals, and every literal is closed. */
function isBalanced(formula: string): boolean {
  let depth = 0
  let insideString = false
  for (const character of formula) {
    if (character === '"') insideString = !insideString
    else if (!insideString && character === '(') depth++
    else if (!insideString && character === ')') depth--
    if (depth < 0) return false
  }
  return depth === 0 && !insideString
}

test('every tracked formula balances', () => {
  assert.ok(isBalanced(DAILY_UNLOCKS_AG3_FORMULA), 'AG3')
  for (const { column, biomeColumn } of UNLOCK_MAP_FORMULA_COLUMNS)
    assert.ok(
      isBalanced(unlockMapColumnFormula(column, biomeColumn)),
      `map column ${column}`,
    )
})

test('sameFormula ignores sheet-name quoting, case and layout, not string literals', () => {
  assert.ok(
    sameFormula(
      "=XLOOKUP(A3:A, 'DAILY_MODE.DATA'!$BY$2:$BY, B:B)",
      '=xlookup(A3:A,\n  DAILY_MODE.data!$BY$2:$BY, B:B)',
    ),
  )
  assert.ok(!sameFormula('=A1 & " (IV)"', '=A1 & "(IV)"'))
  assert.ok(!sameFormula('=A1 & "Shiny"', '=A1 & "shiny"'))
  assert.equal(
    normalizeFormula(`=REGEXREPLACE(R3:R, " |ures", "")`),
    '=regexreplace(r3:r," |ures","")',
  )
})
