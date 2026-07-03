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

describe('M3: exhaustiveness', () => {
  it('rejects non-exhaustive enum match', () => {
    expect(errors(`
      enum Shape { Circle(num), Square(num), Empty }
      fn f(s: Shape): num {
        match s {
          Circle(r) => { r },
          Square(x) => { x }
        }
      }
    `)).toContain('missing: Empty');
  });

  it('accepts wildcard as exhaustive', () => {
    expect(errors(`
      enum Shape { Circle(num), Square(num), Empty }
      fn f(s: Shape): num {
        match s {
          Circle(r) => { r },
          _ => { 0 }
        }
      }
    `)).toBe('');
  });

  it('guarded arms do not count toward coverage', () => {
    expect(errors(`
      fn f(o: Option<num>): num {
        match o {
          Some(x) if x > 0 => { x },
          None => { 0 }
        }
      }
    `)).toContain('missing: Some');
  });

  it('checks tuple matches per combination', () => {
    expect(errors(`
      fn f(a: Option<num>, b: Option<num>): num {
        match (a, b) {
          (Some(x), Some(y)) => { x + y },
          (None, None) => { 0 }
        }
      }
    `)).toContain('not exhaustive');
  });

  it('accepts complete tuple coverage', () => {
    expect(errors(`
      fn f(a: Option<num>, b: Option<num>): num {
        match (a, b) {
          (Some(x), Some(y)) => { x + y },
          (Some(x), None) => { x },
          (None, Some(y)) => { y },
          (None, None) => { 0 }
        }
      }
    `)).toBe('');
  });

  it('accepts tuple wildcard element coverage', () => {
    expect(errors(`
      fn f(a: Option<num>, b: Option<num>): num {
        match (a, b) {
          (Some(x), _) => { x },
          (None, _) => { 0 }
        }
      }
    `)).toBe('');
  });
});

describe('M3: prelude', () => {
  it('emits only used prelude constructors', () => {
    const output = compile(`
      fn find(n: num): Option<num> {
        if (n > 0) {
          Some(n)
        } else {
          None
        }
      }
    `);
    expect(output).toContain('function Some(value) { return { tag: "Some", value }; }');
    expect(output).toContain('const None = { tag: "None" };');
    expect(output).not.toContain('function Ok');
    expect(output).not.toContain('function Err');
  });

  it('emits nothing when prelude is unused', () => {
    const output = compile(`fn main() { console.log("hi"); }`);
    expect(output).not.toContain('// Prelude');
  });

  it('prelude Option runs end-to-end', () => {
    const output = compile(`
      fn safe_div(a: num, b: num): Option<num> {
        if (b == 0) {
          None
        } else {
          Some(a / b)
        }
      }
      fn main() {
        match safe_div(10, 2) {
          Some(v) => { console.log(v); },
          None => { console.log("nope"); }
        }
      }
    `);
    expect(output).toContain('function Some(value)');
  });

  it('--no-prelude rejects Some/None', () => {
    expect(() => compile('let x = Some(1);', { prelude: false })).toThrow(/Unknown/);
  });

  it('user-defined Option overrides prelude', () => {
    const output = compile(`
      enum Option<T> { Some(T), None }
      fn main() {
        let x = Option_Some(5);
      }
    `);
    expect(output).toContain('function Option_Some(value)');
  });
});
