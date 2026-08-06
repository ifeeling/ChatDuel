import type { AdapterDiagnostics } from '../base'
import type { DiagnosticReporterEvent } from '../../lib/diagnostic-client'

/**
 * 平台无关的诊断上报原语，被五个平台适配器共用。
 *
 * 调用方传入 AdapterDiagnostics 与一条诊断事件，
 * 本函数把 selectorConfigVersion 合并进事件后转发给 reporter。
 * 函数体不含任何平台名分支，因此对任意平台适配器通用；
 * 诊断事件的名称与载荷不变，用户无感知。
 */
export function emitDiagnostic(
  diagnostics: AdapterDiagnostics | undefined,
  event: DiagnosticReporterEvent,
): void {
  diagnostics?.reporter.emit({ ...event, selectorConfigVersion: diagnostics.selectorConfigVersion })
}
