// CLI Entry Point for NovaScript Compiler

import { compileProject } from '../compiler/index.js';
import { writeFileSync } from 'fs';

const USAGE = 'Usage: novascript compile <file.nova> [--no-prelude] [--dts]';

export function main(args: string[]): void {
  const flags = args.filter(a => a.startsWith('--'));
  const positional = args.filter(a => !a.startsWith('--'));

  if (positional.length < 2) {
    console.error(USAGE);
    process.exit(1);
  }

  const command = positional[0];
  const inputFile = positional[1];

  if (command !== 'compile') {
    console.error(`Unknown command: ${command}`);
    console.error(USAGE);
    process.exit(1);
  }

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
    console.error('Compilation failed:');
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(error);
    }
    process.exit(1);
  }
}

// Run if executed directly
if (process.argv[1]?.endsWith('main.ts') || process.argv[1]?.endsWith('main.js')) {
  main(process.argv.slice(2));
}
