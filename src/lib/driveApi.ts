/**
 * Thin, typed wrapper over the Drive advanced service (Drive API v3), limited
 * to listing spreadsheets by name. DriveApp requires a full Drive read scope
 * for every call, including searches; files.list runs under
 * drive.metadata.readonly, the only Drive scope the manifests grant.
 */

/** The metadata the library reads about a spreadsheet in Drive. */
export type DriveSpreadsheet = {
  id: string
  name: string
  /** RFC 3339 timestamp. */
  createdTime: string
  /** RFC 3339 timestamp. */
  modifiedTime: string
  webViewLink: string
}

export type ListParams = {
  q: string
  fields: string
  pageSize: number
  pageToken?: string
}

export type FileList = { files?: DriveSpreadsheet[]; nextPageToken?: string }

type DriveService = { Files?: { list(params: ListParams): FileList } }

const SPREADSHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet'

/**
 * Every non-trashed spreadsheet whose name satisfies `nameCondition`, a Drive
 * query clause such as `name = 'Offline RogueDex 6.04'`.
 */
export function listSpreadsheets(nameCondition: string): DriveSpreadsheet[] {
  const query = `${nameCondition} and mimeType = '${SPREADSHEET_MIME_TYPE}' and trashed = false`
  const spreadsheets: DriveSpreadsheet[] = []
  let pageToken: string | undefined
  do {
    const page = filesService().list({
      q: query,
      fields:
        'nextPageToken, files(id, name, createdTime, modifiedTime, webViewLink)',
      pageSize: 1000,
      ...(pageToken ? { pageToken } : {}),
    })
    spreadsheets.push(...(page.files ?? []))
    pageToken = page.nextPageToken
  } while (pageToken)
  return spreadsheets
}

/** A quoted string literal for a Drive query: driveQueryString("it's") = 'it\'s'. */
export function driveQueryString(text: string): string {
  return "'" + text.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
}

function filesService(): NonNullable<DriveService['Files']> {
  const driveService = (globalThis as { Drive?: DriveService }).Drive
  if (!driveService?.Files) {
    throw new Error(
      'The Drive advanced service is not enabled for the OfflineDex Library (appsscript.json → enabledAdvancedServices).',
    )
  }
  return driveService.Files
}
