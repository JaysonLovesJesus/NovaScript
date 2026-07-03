import { describe, it, expect } from 'vitest';
import { compile } from '../compiler/index.js';

function errors(source: string): string {
  try {
    compile(source);
    return '';
  } catch (e) {
    return (e as Error).message;
  }
}

describe('M5: unsafe interop', () => {
  it('emits import unsafe as a plain JS import', () => {
    const output = compile(`
      import unsafe { readFileSync } from "node:fs";
      fn main() {
        let data = unsafe { readFileSync("x.txt", "utf-8") };
        console.log(data);
      }
    `);
    expect(output).toContain('import { readFileSync } from "node:fs";');
  });

  it('rejects unsafe imports used in safe code', () => {
    expect(errors(`
      import unsafe { readFileSync } from "node:fs";
      fn main() {
        let data = readFileSync("x.txt");
      }
    `)).toContain('can only be used inside unsafe blocks');
  });

  it('allows safe imports anywhere', () => {
    expect(errors(`
      import { helper } from "./helper.js";
      fn main() {
        helper(1);
      }
    `)).toBe('');
  });

  it('compiles unsafe expressions inline', () => {
    const output = compile(`
      fn now(): num {
        unsafe { Date.now() }
      }
    `);
    expect(output).toContain('return (Date.now());');
  });

  it('trusts unsafe expression to match annotation', () => {
    expect(errors(`
      fn main() {
        let t: num = unsafe { Date.now() };
        let s = t + 1;
      }
    `)).toBe('');
  });

  it('passes top-level unsafe through as raw JS', () => {
    const output = compile(`unsafe { console.log("raw"); }`);
    expect(output).toContain('console.log("raw");');
  });
});
