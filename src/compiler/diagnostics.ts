// Diagnostics for the NovaScript checker.

export interface Diagnostic {
  message: string;
  /** Human-readable context, e.g. "function area" — AST nodes don't carry spans yet */
  context?: string;
  severity: 'error' | 'warning';
}

export class CheckError extends Error {
  constructor(public diagnostics: Diagnostic[]) {
    super(diagnostics.map(d => d.context ? `[${d.context}] ${d.message}` : d.message).join('\n'));
    this.name = 'CheckError';
  }
}
