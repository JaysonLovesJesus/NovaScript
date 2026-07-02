// NovaScript Compiler - Main Entry Point

import { parse } from './parser.js';
import { generate } from './codegen.js';

export function compile(source: string): string {
  const ast = parse(source);
  return generate(ast);
}

export { parse } from './parser.js';
export { generate } from './codegen.js';
export { tokenize } from './lexer.js';
export type { Program, Expr, Stmt } from './ast.js';
