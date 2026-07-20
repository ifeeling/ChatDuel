import {
  serializeDiagnosticExport,
  type DiagnosticExportPayload,
} from './diagnostic-retention'

export interface PreparedDiagnosticExport {
  previewText: string
  clipboardText: string
  blob: Blob
}

export function prepareDiagnosticExport(payload: DiagnosticExportPayload): PreparedDiagnosticExport {
  const text = serializeDiagnosticExport(payload)
  return {
    previewText: text,
    clipboardText: text,
    blob: new Blob([text], { type: 'application/json;charset=utf-8' }),
  }
}
