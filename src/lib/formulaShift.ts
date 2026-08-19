/**
 * Shift the column references of a formula the way Google Sheets does when
 * columns are inserted: every UNQUALIFIED (same-sheet) reference whose column
 * is at or right of `fromColumn` moves right by `offset`; sheet-qualified
 * references ('Other'!F1), string literals and function names are untouched.
 *
 * Used by the Migrator to port your Quick Checklist header formulas into a
 * destination whose data block starts further right (creator 6.03 added a
 * column) without the temp-sheet insertColumns trick.
 */

export function columnToIndex(letters: string): number {
  let index = 0
  for (const letter of letters.toUpperCase())
    index = index * 26 + (letter.charCodeAt(0) - 64)
  return index
}

export function indexToColumn(columnIndex: number): string {
  let letters = ''
  let remaining = columnIndex
  while (remaining > 0) {
    const remainder = (remaining - 1) % 26
    letters = String.fromCharCode(65 + remainder) + letters
    remaining = Math.floor((remaining - 1) / 26)
  }
  return letters
}

const isWordChar = (char: string): boolean => /[A-Za-z0-9_.]/.test(char)

/**
 * @param formula     e.g. '=COUNTIF(F12:F,"☑")+A10'
 * @param fromColumn  1-based column; references to columns >= fromColumn shift
 * @param offset      columns to shift by (0 returns the formula unchanged)
 */
export function shiftFormulaColumns(
  formula: string,
  fromColumn: number,
  offset: number,
): string {
  if (!formula || offset === 0 || !formula.startsWith('=')) return formula
  let shifted = ''
  let pos = 0
  const length = formula.length
  while (pos < length) {
    const char = formula[pos]!
    // String literal: copy verbatim.
    if (char === '"') {
      let end = pos + 1
      while (end < length) {
        if (formula[end] === '"') {
          if (formula[end + 1] === '"') {
            end += 2
            continue
          }
          break
        }
        end++
      }
      shifted += formula.slice(pos, end + 1)
      pos = end + 1
      continue
    }
    // Quoted sheet name: 'My Sheet'!  → copy the name and the following reference untouched.
    if (char === "'") {
      let end = pos + 1
      while (end < length) {
        if (formula[end] === "'") {
          if (formula[end + 1] === "'") {
            end += 2
            continue
          }
          break
        }
        end++
      }
      shifted += formula.slice(pos, end + 1)
      pos = end + 1
      if (formula[pos] === '!') {
        shifted += '!'
        pos++
        const qualifiedRef = readRef(formula, pos)
        shifted += qualifiedRef.text
        pos += qualifiedRef.text.length
      }
      continue
    }
    // Word: could be a bare sheet name (followed by '!'), a function name, or a cell/range ref.
    if (/[A-Za-z_$]/.test(char)) {
      let end = pos
      while (
        end < length &&
        (isWordChar(formula[end]!) ||
          formula[end] === '$' ||
          formula[end] === ':')
      )
        end++
      // Bare sheet qualifier: SheetName!A1
      if (formula[end] === '!') {
        shifted += formula.slice(pos, end + 1)
        pos = end + 1
        const qualifiedRef = readRef(formula, pos)
        shifted += qualifiedRef.text
        pos += qualifiedRef.text.length
        continue
      }
      // Function name: identifier followed by '('
      if (formula[end] === '(') {
        shifted += formula.slice(pos, end)
        pos = end
        continue
      }
      const localRef = readRef(formula, pos)
      if (localRef.text) {
        shifted += shiftRef(localRef.text, fromColumn, offset)
        pos += localRef.text.length
        continue
      }
      shifted += formula.slice(pos, end)
      pos = end
      continue
    }
    shifted += char
    pos++
  }
  return shifted
}

/** A1-style reference (cell, range, column range, row range) starting at `pos`, or ''. */
function readRef(formula: string, pos: number): { text: string } {
  const rest = formula.slice(pos)
  const match = rest.match(
    /^(\$?[A-Z]{1,3}\$?\d*|\$?\d+)(:(\$?[A-Z]{1,3}\$?\d*|\$?\d+))?(?![A-Za-z0-9_(])/,
  )
  if (!match) return { text: '' }
  // Reject things like "TRUE" (4 letters get split) — the regex caps at 3 letters
  // and the negative lookahead refuses a following letter, so "TRUE" never matches.
  return { text: match[0] }
}

function shiftRef(ref: string, fromColumn: number, offset: number): string {
  return ref
    .split(':')
    .map((part) => {
      const match = part.match(/^(\$?)([A-Z]{1,3})(\$?\d*)$/)
      if (!match) return part // row-only part like "12" or "$12"
      const [, dollar, columnLetters, rowPart] = match
      const column = columnToIndex(columnLetters!)
      if (column < fromColumn) return part
      return dollar + indexToColumn(column + offset) + rowPart
    })
    .join(':')
}
