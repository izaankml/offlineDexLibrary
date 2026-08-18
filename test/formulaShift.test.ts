import assert from 'node:assert/strict'
import { test } from 'node:test'
import { shiftFormulaColumns } from '../src/lib/formulaShift.ts'

const cases: [string, number, number, string][] = [
  ['=COUNTIF(F12:F,"☑")', 5, 1, '=COUNTIF(G12:G,"☑")'],
  ['=A10+F1', 5, 1, '=A10+G1'],
  ['=E1+F1', 6, 1, '=E1+G1'],
  ["='STATIC:VERSION'!A1+F1", 5, 1, "='STATIC:VERSION'!A1+G1"],
  ['=Other!F1+F1', 5, 1, '=Other!G1+F1'.replace('G1+F1', 'F1+G1')],
  ['=Other!F1:F+F1', 5, 1, '=Other!F1:F+G1'],
  ['="F1"&F1', 5, 1, '="F1"&G1'],
  ['=SUM($F$1:$K$1)', 5, 1, '=SUM($G$1:$L$1)'],
  ['=IF(TRUE,E1,F1)', 6, 1, '=IF(TRUE,E1,G1)'],
  ['=EXP(1)+LOG10(F1)', 5, 1, '=EXP(1)+LOG10(G1)'],
  ['=COUNTA(F:F)/COUNTA(A:A)', 5, 2, '=COUNTA(H:H)/COUNTA(A:A)'],
  ['=F1', 5, 0, '=F1'],
  ['plain text F1', 5, 1, 'plain text F1'],
  ['=STARTER_CHECKLIST.data!D12', 1, 3, '=STARTER_CHECKLIST.data!D12'],
  ['=Sheet1!$F$1+$F$1', 5, 1, '=Sheet1!$F$1+$G$1'],
  ['=F1&""""&F1', 5, 1, '=G1&""""&G1'],
  ["='It''s'!F1+F1", 5, 1, "='It''s'!F1+G1"],
]

for (const [input, from, offset, expected] of cases) {
  test(`shift ${input} from col ${from} by ${offset}`, () => {
    assert.equal(shiftFormulaColumns(input, from, offset), expected)
  })
}
