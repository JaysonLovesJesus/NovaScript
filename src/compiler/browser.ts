// Browser-safe entry surface for the compiler.
//
// This barrel deliberately excludes the module system (modules.ts), which reads
// from the filesystem. Everything re-exported here is pure and bundleable for
// the playground: single-file compilation, formatting, and error rendering.

export { compile } from './compile.js';
export type { CompileOptions } from './compile.js';
export { format } from './format.js';
export { formatError, renderCodeFrame, CompileError } from './render.js';
export { parse } from './parser.js';
export { tokenize } from './lexer.js';
