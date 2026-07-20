import { describe, expect, it } from 'vitest'
import { prepareDiagnosticExport } from '../../src/lib/diagnostic-export'
import {
  DIAGNOSTIC_EXPORT_NOTICE,
  type DiagnosticExportPayload,
} from '../../src/lib/diagnostic-retention'

const payload: DiagnosticExportPayload = {
  exportSchemaVersion: 1,
  exportedAt: 1_750_000_000_000,
  extensionVersion: '0.4.13',
  notice: DIAGNOSTIC_EXPORT_NOTICE,
  retention: {
    maxAgeDays: 7,
    maxBatches: 20,
    maxRuns: 100,
    maxEvents: 1_000,
    maxBytes: 1_000_000,
  },
  fieldDefinitionsVersion: 1,
  batches: [],
}

describe('diagnostic export', () => {
  it('reuses one serialized string for preview copy and download', async () => {
    const prepared = prepareDiagnosticExport(payload)
    const blobText = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(reader.error)
      reader.onload = () => resolve(String(reader.result ?? ''))
      reader.readAsText(prepared.blob)
    })

    expect(prepared.previewText).toBe(prepared.clipboardText)
    expect(blobText).toBe(prepared.previewText)
  })
})
