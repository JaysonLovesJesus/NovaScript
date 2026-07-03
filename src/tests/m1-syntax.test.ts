import { describe, it, expect } from 'vitest';
import { compile, parse } from '../compiler/index.js';

describe('M1 syntax additions', () => {
  it('compiles for-in over a range to a counting loop', () => {
    const output = compile(`
      fn main() {
        for i in 0..5 {
          console.log(i);
        }
      }
    `);
    expect(output).toContain('for (let i = 0; i < 5; i++) {');
  });

  it('compiles for-in over an array to for-of', () => {
    const output = compile(`
      fn main() {
        let items = [1, 2, 3];
        for item in items {
          console.log(item);
        }
      }
    `);
    expect(output).toContain('for (const item of items) {');
  });

  it('compiles string interpolation to JS template literals', () => {
    const output = compile('let name = "sam"; let age = 4; let msg = `hello ${name}, you are ${age + 1}`;');
    expect(output).toContain('const msg = `hello ${name}, you are ${(age + 1)}`;');
  });

  it('compiles array indexing', () => {
    const output = compile('let arr = [1, 2, 3]; let i = 0; let x = arr[i + 1];');
    expect(output).toContain('const x = arr[(i + 1)];');
  });

  it('parses generic type parameters on functions and structs', () => {
    const ast = parse(`
      fn identity<T>(x: T): T { x }
      struct Box<T> { value: T; }
    `);
    const fn = ast.declarations[0];
    const struct = ast.declarations[1];
    expect(fn.kind === 'function' && fn.typeParams).toEqual(['T']);
    expect(struct.kind === 'struct' && struct.typeParams).toEqual(['T']);
  });

  it('compiles struct literals to constructor calls', () => {
    const output = compile(`
      struct Vec2 {
        x: num;
        y: num;
      }

      fn main() {
        let v = Vec2 { x: 1, y: 2 };
        console.log(v.x);
      }
    `);
    expect(output).toContain('const v = Vec2(1, 2);');
  });

  it('matches tuple patterns with nested variant bindings', () => {
    const output = compile(`
      enum Opt {
        Some(num),
        None
      }

      fn both(a: Opt, b: Opt): num {
        match (a, b) {
          (Some(x), Some(y)) => { x + y },
          _ => { 0 }
        }
      }
    `);
    expect(output).toContain('__match_val[0].tag === "Some" && __match_val[1].tag === "Some"');
    expect(output).toContain('const x = __match_val[0].value;');
    expect(output).toContain('const y = __match_val[1].value;');
  });

  it('parses let with type annotation', () => {
    const output = compile('let x: num = 5;');
    expect(output).toContain('const x = 5;');
  });
});
