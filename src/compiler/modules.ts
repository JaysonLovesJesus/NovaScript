// Multi-file compilation.
//
// Starting from an entry file, follows the `import ... from "./x"` graph,
// type-checks every module against the real (imported) declarations of the
// others, then lowers and emits one ESM `.js` (and optional `.d.ts`) per file.

import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { parse } from './parser.js';
import { check } from './checker.js';
import { evaluateComptime } from './comptime.js';
import { lower } from './lower.js';
import { generate } from './codegen.js';
import { emitDts } from './dts.js';
import type { Program, FunctionDecl, StructDecl, EnumDecl } from './ast.js';

type TopDecl = FunctionDecl | StructDecl | EnumDecl;

export interface ProjectOptions {
  prelude?: boolean;
  /** Also produce a .d.ts for each module. */
  dts?: boolean;
}

export interface CompiledModule {
  /** Absolute source path (…/foo.nova). */
  path: string;
  /** Output path (…/foo.js). */
  outPath: string;
  js: string;
  dtsPath?: string;
  dts?: string;
}

interface LoadedModule {
  path: string;
  program: Program;
  /** Resolved absolute path for each import's source specifier. */
  importTargets: Map<string, string>; // from-specifier -> absolute .nova path
}

function resolveImport(fromSpecifier: string, importerPath: string): string {
  const base = fromSpecifier.replace(/\.nova$/, '');
  return resolve(dirname(importerPath), base + '.nova');
}

// BFS the import graph from the entry, parsing each reachable module once.
function loadGraph(entryPath: string): Map<string, LoadedModule> {
  const modules = new Map<string, LoadedModule>();
  const queue = [resolve(entryPath)];

  while (queue.length) {
    const path = queue.shift()!;
    if (modules.has(path)) continue;

    const source = readFileSync(path, 'utf-8');
    const program = parse(source);
    const importTargets = new Map<string, string>();

    for (const stmt of program.statements) {
      if (stmt.kind !== 'import' || stmt.isUnsafe) continue;
      // Only relative imports refer to other NovaScript modules
      if (!stmt.from.startsWith('.')) continue;
      const target = resolveImport(stmt.from, path);
      importTargets.set(stmt.from, target);
      queue.push(target);
    }

    modules.set(path, { path, program, importTargets });
  }

  return modules;
}

export function compileProject(entryPath: string, options: ProjectOptions = {}): CompiledModule[] {
  const absEntry = resolve(entryPath);
  const modules = loadGraph(absEntry);

  // A name is "provided" by a module if the module declares it pub. Imported
  // names are re-exported, so resolve a name to whichever module originally
  // declares it by walking the graph until a pub declaration is found.
  const pubDecls = new Map<string, TopDecl>(); // name -> decl (first pub definition wins)
  for (const mod of modules.values()) {
    for (const decl of mod.program.declarations) {
      if (decl.isPub && !pubDecls.has(decl.name)) pubDecls.set(decl.name, decl);
    }
  }

  const results: CompiledModule[] = [];

  for (const mod of modules.values()) {
    // Externals: the real declarations behind this module's imported names
    const externals: TopDecl[] = [];
    for (const stmt of mod.program.statements) {
      if (stmt.kind !== 'import' || stmt.isUnsafe) continue;
      for (const name of stmt.names) {
        const decl = pubDecls.get(name);
        if (decl) externals.push(decl);
      }
    }

    check(mod.program, { prelude: options.prelude, externals });
    evaluateComptime(mod.program);
    lower(mod.program);

    const isEntry = mod.path === absEntry;
    const externalStructs = externals.filter((d): d is StructDecl => d.kind === 'struct');
    const js = generate(mod.program, { module: true, entry: isEntry, externalStructs });
    const outPath = mod.path.replace(/\.nova$/, '.js');

    const compiled: CompiledModule = { path: mod.path, outPath, js };
    if (options.dts) {
      compiled.dts = emitDts(mod.program);
      compiled.dtsPath = mod.path.replace(/\.nova$/, '.d.ts');
    }
    results.push(compiled);
  }

  return results;
}
