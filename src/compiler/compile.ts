// Single-file compilation. Kept separate from index.ts (which re-exports the
// filesystem-backed module system) so the browser bundle can import it without
// pulling in Node's fs/path.

import { parse } from './parser.js';
import { check, CheckOptions } from './checker.js';
import { evaluateComptime } from './comptime.js';
import { lower } from './lower.js';
import { generate } from './codegen.js';
import { formatError, CompileError } from './render.js';

export interface CompileOptions {
  /** Inject the Option/Result prelude (default true) */
  prelude?: boolean;
  /** File name used in framed error output. */
  file?: string;
}

/**
 * Compile a single source string to JS. On any lex/parse/check failure, throws
 * a CompileError whose message is a rendered code frame (browser-safe: no I/O).
 */
export function compile(source: string, options: CompileOptions = {}): string {
  try {
    const ast = parse(source);
    const checkOptions: CheckOptions = { prelude: options.prelude };
    check(ast, checkOptions);
    evaluateComptime(ast);
    lower(ast);
    return generate(ast);
  } catch (err) {
    if (err instanceof CompileError) throw err;
    throw new CompileError(formatError(err, source, options.file));
  }
}
