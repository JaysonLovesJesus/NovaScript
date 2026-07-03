// NovaScript Compiler - Main Entry Point

import { parse } from './parser.js';
import { check, CheckOptions } from './checker.js';
import { evaluateComptime } from './comptime.js';
import { lower } from './lower.js';
import { generate } from './codegen.js';

export interface CompileOptions {
  /** Inject the Option/Result prelude (default true) */
  prelude?: boolean;
}

export function compile(source: string, options: CompileOptions = {}): string {
  const ast = parse(source);
  const checkOptions: CheckOptions = { prelude: options.prelude };
  check(ast, checkOptions);
  evaluateComptime(ast);
  lower(ast);
  return generate(ast);
}

export { parse } from './parser.js';
export { check, Checker } from './checker.js';
export { generate } from './codegen.js';
export { tokenize } from './lexer.js';
export { CheckError } from './diagnostics.js';
export { compileProject } from './modules.js';
export type { CompiledModule, ProjectOptions } from './modules.js';
export { emitDts } from './dts.js';
export type { Program, Expr, Stmt } from './ast.js';
