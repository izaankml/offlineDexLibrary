/**
 * The one home of the "Offline RogueDex X.YY" naming rules and the creator's
 * public-sheet ID. Bundled into the Apps Script library AND imported by the
 * update CLI, so both runtimes agree by construction.
 */

/**
 * The creator publishes every version as the SAME Drive file, renamed on each
 * release (e.g. "PUBLIC_Offline RogueDex 6.03"). Reading its title tells us the
 * newest version; copying it gives a fresh copy with the creator's bound code.
 */
export const PUBLIC_SHEET_FILE_ID =
  '1peZNMRqicwfGAMYYJq6aeA13_1ZFVKvl--_gVQOdfv0'

const COPY_NAME_PREFIX = 'Offline RogueDex '
/** Exact match for one of your copies. */
export const COPY_NAME_RE = /^Offline RogueDex (\d+\.\d+)$/
/** The first "X.YY" anywhere in a name. */
export const VERSION_RE = /\d+\.\d+/

/** "Offline RogueDex 6.03" for '6.03'. */
export function copyName(version: string): string {
  return COPY_NAME_PREFIX + version
}

/** The first "X.YY" in a sheet/file name, or null if there isn't one. */
export function versionFromName(name: string): string | null {
  const match = String(name).match(VERSION_RE)
  return match ? match[0] : null
}

/** Numeric compare of "major.minor" strings: negative, zero, positive. */
export function compareVersions(versionA: string, versionB: string): number {
  const partsA = String(versionA).split('.').map(Number)
  const partsB = String(versionB).split('.').map(Number)
  for (let index = 0; index < Math.max(partsA.length, partsB.length); index++) {
    const difference = (partsA[index] ?? 0) - (partsB[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/**
 * Accept a bare Apps Script ID or any URL that contains one
 * (script.google.com/.../projects/<id>/edit, ?scriptId=..., etc.).
 * Returns null when nothing that looks like a Script ID is present.
 */
export function extractScriptId(target: string): string | null {
  const trimmed = target.trim()
  const fromPath = trimmed.match(/\/projects\/([A-Za-z0-9_-]{20,})/)
  if (fromPath) return fromPath[1] ?? null
  const fromQuery = trimmed.match(/[?&]scriptId=([A-Za-z0-9_-]{20,})/)
  if (fromQuery) return fromQuery[1] ?? null
  if (/^[A-Za-z0-9_-]{20,}$/.test(trimmed)) return trimmed
  return null
}
