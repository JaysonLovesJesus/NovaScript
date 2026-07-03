// Diagnostics for the NovaScript checker.

export interface Diagnostic {
  message: string;
  /** Human-readable context, e.g. "function area". */
  context?: string;
  /** 1-based source position of the offending node, when known. */
  line?: number;
  column?: number;
  severity: 'error' | 'warning';
}

export class CheckError extends Error {
  constructor(public diagnostics: Diagnostic[]) {
    super(diagnostics.map(d => d.context ? `[${d.context}] ${d.message}` : d.message).join('\n'));
    this.name = 'CheckError';
  }
}
