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

describe('M6: .try lowering', () => {
  it('hoists .try into an early-return guard', () => {
    const output = compile(`
      fn parse(s: str): Result<num, str> { Ok(1) }
      fn run(s: str): Result<num, str> {
        let n = parse(s).try;
        Ok(n + 1)
      }
    `);
    expect(output).toContain('const __t1 = parse(s);');
    expect(output).toContain('if ((__t1.tag === "Err")) {');
    expect(output).toContain('return __t1;');
    expect(output).toContain('const n = __t1.value;');
    expect(output).not.toContain('=> {'); // no IIFE for .try
  });

  it('hoists ? into an early None return', () => {
    const output = compile(`
      fn head(xs: num[]): Option<num> {
        if (xs.length == 0) { return None; }
        Some(xs[0])
      }
      fn firstDoubled(xs: num[]): Option<num> {
        let h = head(xs)?;
        Some(h * 2)
      }
    `);
    expect(output).toContain('if ((__t1.tag === "None")) {');
    expect(output).toContain('return None;');
    expect(output).toContain('const h = __t1.value;');
  });

  it('rejects .try in a function not returning Result', () => {
    expect(errors(`
      fn parse(s: str): Result<num, str> { Ok(1) }
      fn run(s: str): num {
        parse(s).try
      }
    `)).toContain('can only be used in a function returning Result');
  });

  it('rejects ? on non-Option values', () => {
    expect(errors(`
      fn f(): Option<num> {
        let x = 5?;
        Some(1)
      }
    `)).toContain("'?' requires an Option");
  });

  it('chains .try in sequence', () => {
    const output = compile(`
      fn step1(): Result<num, str> { Ok(1) }
      fn step2(n: num): Result<num, str> { Ok(n + 1) }
      fn pipeline(): Result<num, str> {
        let a = step1().try;
        let b = step2(a).try;
        Ok(b)
      }
    `);
    expect(output).toContain('const __t1 = step1();');
    expect(output).toContain('const a = __t1.value;');
    expect(output).toContain('const __t2 = step2(a);');
    expect(output).toContain('const b = __t2.value;');
  });
});

describe('M6: implicit async', () => {
  it('marks functions using .await as async', () => {
    const output = compile(`
      import { fetchData } from "./api.js";
      fn load(): void {
        let d = fetchData(1).await;
        console.log(d);
      }
    `);
    expect(output).toContain('async function load()');
    expect(output).toContain('(await fetchData(1))');
  });

  it('types calls to async functions as Promise', () => {
    expect(errors(`
      import { fetchData } from "./api.js";
      fn load(): num {
        let d = fetchData(1).await;
        1
      }
      fn caller(): num {
        load() + 1
      }
    `)).toContain("requires num operands");
  });

  it('awaiting an async call unwraps the Promise', () => {
    expect(errors(`
      import { fetchData } from "./api.js";
      fn load(): num {
        fetchData(1).await;
        1
      }
      fn caller(): num {
        load().await + 1
      }
    `)).toBe('');
  });
});
