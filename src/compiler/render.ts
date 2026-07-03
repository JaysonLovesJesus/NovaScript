// Renders rustc-style code frames for compiler diagnostics.
//
//   error: expected num, got str
//    ─> main.nova:3:19
//     │
//   3 │     let x = twice("hello");
//     │                   ^
//
// Given the source text and a 1-based line/column, produces the framed snippet.
// Used by the CLI and playground to turn parse/lex/check errors into legible
// output. Pure string work — no I/O, so it runs in the browser too.

/** A compile failure whose message is already a rendered code frame. */
export class CompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompileError';
  }
}

export interface FrameOptions {
  /** Source file name shown in the location line (optional). */
  file?: string;
  /** Severity label; defaults to "error". */
  label?: string;
}

const POS_PREFIX = /^\[\d+:\d+\]\s*/;

/**
 * Turn any compiler error (lex, parse, or check) into framed output against the
 * given source. Duck-typed so render.ts stays free of import cycles.
 */
export function formatError(error: unknown, source: string, file?: string): string {
  const e = error as any;

  // CheckError: one frame per diagnostic
  if (e && Array.isArray(e.diagnostics)) {
    return e.diagnostics
      .map((d: any) => {
        const msg = d.context && !d.line ? `${d.message} (in ${d.context})` : d.message;
        return renderCodeFrame(source, d.line, d.column, msg, { file });
      })
      .join('\n\n');
  }

  // LexerError: line/column fields directly on the error
  if (e && typeof e.line === 'number' && typeof e.column === 'number') {
    return renderCodeFrame(source, e.line, e.column, stripPos(e.message), { file });
  }

  // ParseError: position carried on a token
  if (e && e.token && typeof e.token.line === 'number') {
    return renderCodeFrame(source, e.token.line, e.token.column, stripPos(e.message), { file });
  }

  // Unknown error shape: fall back to its message.
  return `error: ${e?.message ?? String(error)}`;
}

function stripPos(message: string): string {
  return message.replace(POS_PREFIX, '');
}

/** A single framed diagnostic. */
export function renderCodeFrame(
  source: string,
  line: number | undefined,
  column: number | undefined,
  message: string,
  options: FrameOptions = {},
): string {
  const label = options.label ?? 'error';
  const head = `${label}: ${message}`;

  // No position → just the message (still better than a bare stack trace).
  if (!line || line < 1) return head;

  const lines = source.split('\n');
  const srcLine = lines[line - 1] ?? '';
  const col = Math.max(1, column ?? 1);
  const gutter = String(line);
  const pad = ' '.repeat(gutter.length);
  const loc = options.file ? `${options.file}:${line}:${col}` : `${line}:${col}`;
  const caretPad = ' '.repeat(col - 1);

  return [
    head,
    `${pad} ─> ${loc}`,
    `${pad} │`,
    `${gutter} │ ${srcLine}`,
    `${pad} │ ${caretPad}^`,
  ].join('\n');
}
