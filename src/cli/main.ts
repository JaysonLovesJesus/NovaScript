// CLI Entry Point for NovaScript Compiler

import { compile } from '../compiler/index.js';
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function main(args: string[]): void {
  if (args.length < 2) {
    console.error('Usage: novascript compile <file.nova>');
    process.exit(1);
  }

  const command = args[0];
  const inputFile = args[1];

  if (command !== 'compile') {
    console.error(`Unknown command: ${command}`);
    console.error('Usage: novascript compile <file.nova>');
    process.exit(1);
  }

  try {
    const source = readFileSync(inputFile, 'utf-8');
    const output = compile(source);
    const outputFile = inputFile.replace(/\.nova$/, '.js');
    writeFileSync(outputFile, output);
    console.log(`Compiled ${inputFile} → ${outputFile}`);
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
