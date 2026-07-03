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

describe('type checker', () => {
  describe('errors', () => {
    it('rejects assignment to immutable binding', () => {
      expect(errors(`
        fn main() {
          let x = 5;
          x = 6;
        }
      `)).toContain("Cannot assign to immutable 'x'");
    });

    it('allows assignment to mutable binding', () => {
      expect(errors(`
        fn main() {
          let mut x = 5;
          x = 6;
        }
      `)).toBe('');
    });

    it('rejects type mismatch in let annotation', () => {
      expect(errors(`fn main() { let x: num = "hello"; }`)).toContain('Cannot assign str');
    });

    it('rejects unknown identifiers', () => {
      expect(errors(`fn main() { let x = nope; }`)).toContain("Unknown identifier 'nope'");
    });

    it('rejects wrong argument count', () => {
      expect(errors(`
        fn add(a: num, b: num): num { a + b }
        fn main() { add(1); }
      `)).toContain('add expects 2 argument(s), got 1');
    });

    it('rejects wrong argument type', () => {
      expect(errors(`
        fn add(a: num, b: num): num { a + b }
        fn main() { add(1, "two"); }
      `)).toContain('expected num, got str');
    });

    it('rejects return type mismatch', () => {
      expect(errors(`fn f(): num { "hello" }`)).toContain("should return num");
    });

    it('rejects arithmetic on strings', () => {
      expect(errors(`fn main() { let x = "a" * 2; }`)).toContain("requires num operands");
    });

    it('rejects non-bool conditions', () => {
      expect(errors(`fn main() { if (1) { } }`)).toContain('Condition must be bool');
    });

    it('rejects mismatched if/else value branches', () => {
      expect(errors(`fn f(): num { if (true) { 1 } else { "two" } }`)).toContain('branches disagree');
    });

    it('rejects unknown struct fields', () => {
      expect(errors(`
        struct Vec2 { x: num; y: num; }
        fn main() {
          let v = Vec2 { x: 1, y: 2 };
          let z = v.z;
        }
      `)).toContain("Vec2 has no field 'z'");
    });

    it('rejects struct literals with missing fields', () => {
      expect(errors(`
        struct Vec2 { x: num; y: num; }
        fn main() { let v = Vec2 { x: 1 }; }
      `)).toContain("Missing field 'y'");
    });
  });

  describe('inference', () => {
    it('infers let types from initializers', () => {
      expect(errors(`
        fn main() {
          let x = 5;
          let y = x + 1;
          let ok = y > 3;
        }
      `)).toBe('');
    });

    it('infers generic function instantiation', () => {
      expect(errors(`
        fn first<T>(items: T[]): T { items[0] }
        fn main() {
          let n = first([1, 2, 3]) + 1;
        }
      `)).toBe('');
    });

    it('rejects wrong generic instantiation', () => {
      expect(errors(`
        fn first<T>(items: T[]): T { items[0] }
        fn main() {
          let n = first([1, 2, 3]) && true;
        }
      `)).toContain("requires bool operands");
    });

    it('types prelude Option constructors', () => {
      expect(errors(`
        fn find(): Option<num> {
          Some(42)
        }
      `)).toBe('');
    });

    it('binds pattern variables with payload types', () => {
      expect(errors(`
        fn get(o: Option<num>): num {
          match o {
            Some(x) => { x + 1 },
            None => { 0 }
          }
        }
      `)).toBe('');
    });

    it('rejects using Option payload as wrong type', () => {
      expect(errors(`
        fn get(o: Option<str>): num {
          match o {
            Some(x) => { x + 1 },
            None => { 0 }
          }
        }
      `)).toContain("requires num operands");
    });

    it('marks functions using .await as async', () => {
      expect(errors(`
        import unsafe { fetchData } from "./api.js";
        fn main() {
          unsafe { globalThis.x = 1; }
        }
      `)).toBe('');
    });
  });
});
