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

describe('M7: comptime', () => {
  it('bakes comptime fn results into the output', () => {
    const output = compile(`
      comptime fn damage_table(up_to: num): num[] {
        let mut table = [0];
        for i in 1..up_to {
          table.push(i * 3 + 1);
        }
        table
      }
      let DAMAGE = damage_table(5);
      console.log(DAMAGE);
    `);
    expect(output).toContain('const DAMAGE = [0, 4, 7, 10, 13];');
    expect(output).not.toContain('function damage_table');
  });

  it('supports comptime fns calling comptime fns', () => {
    const output = compile(`
      comptime fn square(n: num): num { n * n }
      comptime fn sum_squares(k: num): num {
        let mut total = 0;
        for i in 0..k {
          total = total + square(i);
        }
        total
      }
      let S = sum_squares(4);
    `);
    expect(output).toContain('const S = 14;');
  });

  it('rejects unsafe inside comptime fns', () => {
    expect(errors(`
      comptime fn evil(): num {
        unsafe { Date.now() }
      }
      let x = evil();
    `)).toContain('unsafe is not allowed in comptime code');
  });

  it('rejects non-constant arguments to comptime calls', () => {
    expect(errors(`
      comptime fn double(n: num): num { n * 2 }
      fn main(k: num): num {
        double(k)
      }
    `)).toContain('requires constant arguments');
  });

  it('comptime fns can be pub', () => {
    expect(errors(`
      pub comptime fn table(): num[] { [1, 2, 3] }
      let T = table();
    `)).toBe('');
  });
});

describe('M7: generics with structural checks', () => {
  it('infers and erases generics', () => {
    const output = compile(`
      fn last<T>(items: T[]): T { items[items.length - 1] }
      fn main() {
        let n = last([1, 2, 3]);
        let s = last(["a", "b"]);
        console.log(n, s);
      }
    `);
    expect(output).toContain('function last(items)');
  });

  it('propagates generic mismatches', () => {
    expect(errors(`
      fn last<T>(items: T[]): T { items[items.length - 1] }
      fn main() {
        let n: num = last(["a", "b"]);
      }
    `)).toContain('Cannot assign str');
  });
});
