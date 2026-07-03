import { describe, it, expect } from 'vitest';
import { format } from '../compiler/format.js';
import { parse } from '../compiler/parser.js';
import { compile } from '../compiler/index.js';

describe('formatter', () => {
  it('normalizes indentation to 4 spaces', () => {
    const out = format(`fn main() {\n  let x = 1;\n      let y = 2;\n}`);
    expect(out).toBe([
      'fn main() {',
      '    let x = 1;',
      '    let y = 2;',
      '}',
      '',
    ].join('\n'));
  });

  it('canonicalizes spacing and type aliases', () => {
    const out = format(`fn add(a:number,b:number):number{a+b}`);
    expect(out).toContain('fn add(a: num, b: num): num {');
    expect(out).toContain('a + b');
  });

  it('preserves standalone and trailing comments', () => {
    const out = format([
      '// a leading note',
      'fn main() {',
      '    let x = 1; // trailing note',
      '}',
    ].join('\n'));
    expect(out).toContain('// a leading note');
    expect(out).toContain('let x = 1;  // trailing note');
  });

  it('formats struct methods without the fn keyword and with self', () => {
    const out = format(`struct V { x: num, plus(self, o: V): V { V { x: self.x + o.x } } }`);
    expect(out).toContain('struct V {');
    expect(out).toContain('    x: num,');
    expect(out).toContain('    plus(self, o: V): V {');
    expect(out).not.toContain('fn plus');
  });

  it('renders match arms in brace form', () => {
    const out = format(`fn f(o: Option<num>): num { match o { Some(n) => { n }, None => { 0 } } }`);
    expect(out).toContain('match o {');
    expect(out).toContain('Some(n) => {');
    expect(out).toContain('None => {');
  });

  it('adds precedence parentheses only where needed', () => {
    const out = format(`fn f(): num { (1 + 2) * 3 }`);
    expect(out).toContain('(1 + 2) * 3');
    const flat = format(`fn f(): num { 1 + 2 * 3 }`);
    expect(flat).toContain('1 + 2 * 3');
  });

  it('is idempotent', () => {
    const src = `pub struct P{x:num,y:num}
fn dist(a:P,b:P):num{ let dx=a.x-b.x; let dy=a.y-b.y; dx*dx+dy*dy }`;
    const once = format(src);
    expect(format(once)).toBe(once);
  });

  it('produces reparseable, semantically identical output', () => {
    const src = `fn fib(n: num): num {
      if n < 2 { n } else { fib(n - 1) + fib(n - 2) }
    }
    fn main() { console.log(fib(10)); }`;
    const formatted = format(src);
    expect(() => parse(formatted)).not.toThrow();
    // same generated JS ⇒ same meaning
    expect(compile(formatted)).toBe(compile(src));
  });
});
