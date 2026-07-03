import { describe, it, expect } from 'vitest';
import { compile } from '../compiler/index.js';
import { CompileError } from '../compiler/render.js';

// Run compiled single-file JS and capture console.log output.
function run(src: string): string[] {
  const js = compile(src);
  const logs: string[] = [];
  const fmt = (x: unknown) => (typeof x === 'object' && x !== null ? JSON.stringify(x) : String(x));
  const fn = new Function('console', js);
  fn({ log: (...a: unknown[]) => logs.push(a.map(fmt).join(' ')) });
  return logs;
}

describe('closures', () => {
  it('compiles a single bare-param closure to an arrow fn', () => {
    const js = compile(`fn main() { let inc = fn x => x + 1; console.log(inc(1)); }`);
    expect(js).toContain('(x) => (x + 1)');
  });

  it('compiles a parenthesized multi-param closure', () => {
    const js = compile(`fn main() { let add = fn (a, b) => a + b; console.log(add(2, 3)); }`);
    expect(js).toContain('(a, b) => (a + b)');
  });

  it('runs closures with capture', () => {
    const out = run(`
      fn main() {
        let base = 10;
        let addBase = fn x => x + base;
        console.log(addBase(5));
      }
    `);
    expect(out).toEqual(['15']);
  });

  it('compiles a block-body closure returning its last expression', () => {
    const out = run(`
      fn main() {
        let clamp = fn v => {
          let lo = max(0, v);
          min(255, lo)
        };
        console.log(clamp(300));
        console.log(clamp(-5));
      }
    `);
    expect(out).toEqual(['255', '0']);
  });

  it('infers closure params from a fn-typed parameter (contextual typing)', () => {
    const out = run(`
      fn apply(f: (num): num, x: num): num { f(x) }
      fn main() { console.log(apply(fn n => n + 100, 5)); }
    `);
    expect(out).toEqual(['105']);
  });

  it('scopes .try to the closure, not the enclosing function', () => {
    const src = `
      fn safe_div(a: num, b: num): Result<num, str> {
        if b == 0 { Err("zero") } else { Ok(a / b) }
      }
      fn main() {
        let checked = fn n => {
          let d = safe_div(100, n).try;
          Ok(d + 1)
        };
        console.log(checked(4));
        console.log(checked(0));
      }
    `;
    // the early-return lives inside the arrow, not main
    const js = compile(src);
    expect(js).toMatch(/\(n\) => \{[\s\S]*return __t1;[\s\S]*\}/);
    const out = run(src);
    expect(out[0]).toContain('Ok');
    expect(out[1]).toContain('Err');
  });

  it('makes only the closure async when it awaits', () => {
    const js = compile(`
      fn main() {
        let load = fn u => unsafe { Promise.resolve(u) }.await;
        console.log(load);
      }
    `);
    expect(js).toContain('async (u) =>');
    // main itself stays synchronous
    expect(js).toContain('function main()');
    expect(js).not.toContain('async function main');
  });

  it('type-checks a fn-typed parameter and rejects a bad closure body', () => {
    // closure body returns str where a num is expected by unify against the param
    expect(() => compile(`
      fn apply(f: (num): num, x: num): num { f(x) }
      fn main() { console.log(apply(fn n => "oops", 5)); }
    `)).toThrow(CompileError);
  });

  it('rejects the removed -> arrow in a type', () => {
    expect(() => compile(`fn f(g: (num) -> num): num { g(1) }`)).toThrow(CompileError);
  });
});
