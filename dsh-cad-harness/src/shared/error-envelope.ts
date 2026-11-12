// One error shape for the surfaces that cross a process/HTTP boundary.
//
// WHY: "export failed: ENOENT ..." makes the reader classify the failure. A
// stable code + stage + hint is the machine-readable half; `cause` keeps the
// original text so nothing is hidden.

export type ErrorCode =
  | 'timeout'
  | 'not-found'
  | 'permission'
  | 'network'
  | 'backend-not-available'
  | 'invalid-input'
  | 'export-blocked'
  | 'tool-failed';

export interface ErrorEnvelope {
  code: ErrorCode;
  stage: string;
  hint: string;
  cause: string;
  message: string;
}

const HINTS: Record<ErrorCode, string> = {
  timeout: 'retry, or reduce the workload; a timeout is not a pass and not a failure of the model',
  'not-found': 'check the path/version id; the project or artifact may have moved',
  permission: 'fix permissions or choose a writable project; do not run a write from a read-only install',
  network: 'check network/proxy or the configured mirror, then retry',
  'backend-not-available': 'run npx dsh-cad-backend --show and select an available kernel',
  'invalid-input': 'read the parameter name/type in the error; the tool did not run',
  'export-blocked': 'run delivery_audit/preflight, or confirm the export with a reason',
  'tool-failed': 'read cause; if it repeats, include dsh-cad-doctor --json in the report',
};

/** Classify an error without hiding the original message. */
export function classifyError(error: unknown, stage: string): ErrorEnvelope {
  const cause = String((error as Error)?.message ?? error);
  const code: ErrorCode =
    /timed out|timeout|deadline/i.test(cause) ? 'timeout'
    : /ENOENT|not found|no such file|unknown version|unknown project/i.test(cause) ? 'not-found'
    : /EACCES|EPERM|EROFS|permission denied|read-only/i.test(cause) ? 'permission'
    : /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|network|TLS|SSL|certificate/i.test(cause) ? 'network'
    : /backend_not_available/i.test(cause) ? 'backend-not-available'
    : /export-blocked/i.test(cause) ? 'export-blocked'
    : /invalid|expected|unknown argument|missing .* required|bad request/i.test(cause) ? 'invalid-input'
    : 'tool-failed';
  return { code, stage, hint: HINTS[code], cause, message: cause };
}

/** A compact text form for logs and tool replies. */
export function envelopeText(envelope: ErrorEnvelope): string {
  return `[${envelope.code}] ${envelope.stage}: ${envelope.message}\nhint: ${envelope.hint}`;
}
