// NovaScript Compiler - Main Entry Point

export { compile } from './compile.js';
export type { CompileOptions } from './compile.js';
export { parse } from './parser.js';
export { check, Checker } from './checker.js';
export { generate } from './codegen.js';
export { tokenize } from './lexer.js';
export { CheckError } from './diagnostics.js';
export { compileProject } from './modules.js';
export type { CompiledModule, ProjectOptions } from './modules.js';
export { emitDts } from './dts.js';
export { formatError, renderCodeFrame, CompileError } from './render.js';
export { format } from './format.js';
export type { Program, Expr, Stmt } from './ast.js';
