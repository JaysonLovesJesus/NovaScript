import { describe, it, expect } from 'vitest';
import { compile } from '../compiler/index.js';

// Fixtures are inlined rather than read from examples/ so this suite doesn't
// break while the user reshapes that directory into multi-file modules.
describe('codegen snapshots', () => {
  it('compiles hello world', () => {
    const source = `
      fn main() {
        console.log("Hello, NovaScript!");
      }
    `;
    expect(compile(source)).toMatchSnapshot();
  });

  it('compiles fib', () => {
    const source = `
      fn fib(n: num): num {
        if (n < 2) {
          n
        } else {
          fib(n - 1) + fib(n - 2)
        }
      }

      fn main() {
        let result = fib(10);
        console.log(result);
      }
    `;
    expect(compile(source)).toMatchSnapshot();
  });

  it('compiles option matching', () => {
    const source = `
      fn find(arr: num[], target: num): Option<num> {
        let mut i = 0;
        while (i < arr.length) {
          if (arr[i] == target) {
            return Some(i);
          }
          i = i + 1;
        }
        None
      }
    `;
    expect(compile(source)).toMatchSnapshot();
  });
});

describe('match codegen', () => {
  it('binds enum variant payloads and falls through failed guards', () => {
    const source = `
      enum Shape {
        Circle(num),
        Square(num),
        Empty
      }

      fn area(s: Shape): num {
        match s {
          Circle(r) if r > 0 => { 3 * r * r },
          Circle(r) => { 0 },
          Square(side) => { side * side },
          Empty => { 0 }
        }
      }
    `;
    const output = compile(source);
    expect(output).toContain('const r = __match_val.value;');
    expect(output).toContain('const side = __match_val.value;');
    expect(output).toContain('__match_val.tag === "Circle"');
    expect(output).toMatchSnapshot();
  });

  it('binds multi-field variant payloads by index', () => {
    const source = `
      enum Pair {
        Both(num, num),
        Neither
      }

      fn sum(p: Pair): num {
        match p {
          Both(a, b) => { a + b },
          Neither => { 0 }
        }
      }
    `;
    const output = compile(source);
    expect(output).toContain('const a = __match_val.values[0];');
    expect(output).toContain('const b = __match_val.values[1];');
  });

  it('emits match as expression without stray semicolons', () => {
    const source = `
      enum Flag { On, Off }

      fn flip(f: Flag): num {
        let x = match f {
          On => { 1 },
          Off => { 0 }
        };
        x
      }
    `;
    const output = compile(source);
    expect(output).not.toContain(';;');
    expect(output).toContain('const x = (() => {');
  });
});
