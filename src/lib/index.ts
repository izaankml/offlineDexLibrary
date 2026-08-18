/**
 * Public surface of the OfflineDex Library.
 *
 * Everything exported from this file becomes a top-level function in the
 * bundled Apps Script project (see scripts/build.ts) and is therefore callable
 * from the bound script as `OfflineDexLib.<name>(...)`. Keep it to what the
 * bound script actually uses.
 */

export {
  clearHighlights,
  describeLayout,
  highlightChanges,
  processChanges,
  processChangesWithoutSnapshot,
  snapshot,
} from './saveTracker.ts'

export { finishStep, resetToastProgress, startStep } from './progress.ts'

export { portAll } from './migrator.ts'

export {
  detectPreviousVersion,
  finishSetup,
  nudgeFinishSetupIfFresh,
  prepareNextVersion,
} from './setup.ts'

export { copyName, versionFromName } from '../shared/naming.ts'
