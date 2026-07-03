// CLI Entry Point for NovaScript Compiler

import { compileProject, CompileError, format } from '../compiler/index.js';
import { readFileSync, writeFileSync } from 'fs';

const USAGE = [
  'Usage:',
  '  novascript compile <file.nova> [--no-prelude] [--dts]',
  '  novascript fmt <file.nova>... [--check]',
].join('\n');

export function main(args: string[]): void {
  const flags = args.filter(a => a.startsWith('--'));
  const positional = args.filter(a => !a.startsWith('--'));

  if (positional.length < 2) {
    console.error(USAGE);
    process.exit(1);
  }

  const command = positional[0];

  if (command === 'fmt') {
    runFmt(positional.slice(1), flags.includes('--check'));
    return;
  }

  if (command !== 'compile') {
    console.error(`Unknown command: ${command}`);
    console.error(USAGE);
    process.exit(1);
  }

  const inputFile = positional[1];

  try {
    // Compilation always resolves the import graph from the entry file, so a
    // single-file program and a multi-file project use the same path.
    const modules = compileProject(inputFile, {
      prelude: !flags.includes('--no-prelude'),
      dts: flags.includes('--dts'),
    });

    for (const mod of modules) {
      writeFileSync(mod.outPath, mod.js);
      if (mod.dts && mod.dtsPath) writeFileSync(mod.dtsPath, mod.dts);
    }

    const outputs = modules.map(m => m.outPath).join(', ');
    console.log(`Compiled ${modules.length} module(s) → ${outputs}`);
  } catch (error) {
    // CompileError messages are already rendered code frames; print as-is.
    if (error instanceof CompileError) {
      console.error(error.message);
    } else if (error instanceof Error) {
      console.error('Compilation failed:');
      console.error(error.message);
    } else {
      console.error(error);
    }
    process.exit(1);
  }
}

// Format files in place, or with --check report which are unformatted (exit 1).
function runFmt(files: string[], check: boolean): void {
  let changed = 0;
  for (const file of files) {
    const source = readFileSync(file, 'utf-8');
    let formatted: string;
    try {
      formatted = format(source);
    } catch (error) {
      const msg = error instanceof CompileError ? error.message
        : error instanceof Error ? error.message : String(error);
      console.error(`${file}: ${msg}`);
      process.exit(1);
    }
    if (formatted === source) continue;
    changed++;
    if (check) {
      console.error(`Not formatted: ${file}`);
    } else {
      writeFileSync(file, formatted);
      console.log(`Formatted ${file}`);
    }
  }
  if (check && changed > 0) process.exit(1);
  if (!check && changed === 0) console.log('All files already formatted');
}

// Run if executed directly
if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  main(process.argv.slice(2));
}
