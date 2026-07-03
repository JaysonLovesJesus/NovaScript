// Playground bundle entry. Exposes the browser-safe compiler API on a global
// so the static playground page can call it without a module loader.

import { compile, format, CompileError } from '../compiler/browser.js';

const api = {
  /** Compile NovaScript source to JS. Throws CompileError (framed message). */
  compile,
  /** Reformat NovaScript source. */
  format,
  CompileError,
};

(globalThis as any).NovaScript = api;

export default api;
