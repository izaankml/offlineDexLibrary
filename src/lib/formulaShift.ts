/**
 * Shift the column references of a formula the way Google Sheets does when
 * columns are inserted: every UNQUALIFIED (same-sheet) reference whose column
 * is at or right of `fromCol` moves right by `offset`; sheet-qualified
 * references ('Other'!F1), string literals and function names are untouched.
 *
 * Used by the Migrator to port your Quick Checklist header formulas into a
 * destination whose data block starts further right (creator 6.03 added a
 * column) without the temp-sheet insertColumns trick.
 */

export function columnToIndex(letters: string): number {
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n
}

export function indexToColumn(col: number): string {
  let s = ''
  while (col > 0) {
    const m = (col - 1) % 26
    s = String.fromCharCode(65 + m) + s
    col = Math.floor((col - 1) / 26)
  }
  return s
}

const isWordChar = (ch: string): boolean => /[A-Za-z0-9_.]/.test(ch)

/**
 * @param formula  e.g. '=COUNTIF(F12:F,"☑")+A10'
 * @param fromCol  1-based column; references to columns >= fromCol shift
 * @param offset   columns to shift by (0 returns the formula unchanged)
 */
export function shiftFormulaColumns(formula: string, fromCol: number, offset: number): string {
  if (!formula || offset === 0 || !formula.startsWith('=')) return formula
  let out = ''
  let i = 0
  const n = formula.length
  while (i < n) {
    const ch = formula[i]!
    // String literal: copy verbatim.
    if (ch === '"') {
      let j = i + 1
      while (j < n) {
        if (formula[j] === '"') {
          if (formula[j + 1] === '"') {
            j += 2
            continue
          }
          break
        }
        j++
      }
      out += formula.slice(i, j + 1)
      i = j + 1
      continue
    }
    // Quoted sheet name: 'My Sheet'!  → copy the name and the following reference untouched.
    if (ch === "'") {
      let j = i + 1
      while (j < n) {
        if (formula[j] === "'") {
          if (formula[j + 1] === "'") {
            j += 2
            continue
          }
          break
        }
        j++
      }
      out += formula.slice(i, j + 1)
      i = j + 1
      if (formula[i] === '!') {
        out += '!'
        i++
        const ref = readRef(formula, i)
        out += ref.text
        i += ref.text.length
      }
      continue
    }
    // Word: could be a bare sheet name (followed by '!'), a function name, or a cell/range ref.
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i
      while (j < n && (isWordChar(formula[j]!) || formula[j] === '$' || formula[j] === ':')) j++
      // Bare sheet qualifier: SheetName!A1
      if (formula[j] === '!') {
        out += formula.slice(i, j + 1)
        i = j + 1
        const ref = readRef(formula, i)
        out += ref.text
        i += ref.text.length
        continue
      }
      // Function name: identifier followed by '('
      if (formula[j] === '(') {
        out += formula.slice(i, j)
        i = j
        continue
      }
      const ref = readRef(formula, i)
      if (ref.text) {
        out += shiftRef(ref.text, fromCol, offset)
        i += ref.text.length
        continue
      }
      out += formula.slice(i, j)
      i = j
      continue
    }
    out += ch
    i++
  }
  return out
}

/** A1-style reference (cell, range, column range, row range) starting at `pos`, or ''. */
function readRef(formula: string, pos: number): { text: string } {
  const rest = formula.slice(pos)
  const m = rest.match(/^(\$?[A-Z]{1,3}\$?\d*|\$?\d+)(:(\$?[A-Z]{1,3}\$?\d*|\$?\d+))?(?![A-Za-z0-9_(])/)
  if (!m) return { text: '' }
  // Reject things like "TRUE" (4 letters get split) — the regex caps at 3 letters
  // and the negative lookahead refuses a following letter, so "TRUE" never matches.
  return { text: m[0] }
}

function shiftRef(ref: string, fromCol: number, offset: number): string {
  return ref
    .split(':')
    .map((part) => {
      const m = part.match(/^(\$?)([A-Z]{1,3})(\$?\d*)$/)
      if (!m) return part // row-only part like "12" or "$12"
      const col = columnToIndex(m[2]!)
      if (col < fromCol) return part
      return m[1] + indexToColumn(col + offset) + m[3]
    })
    .join(':')
}
