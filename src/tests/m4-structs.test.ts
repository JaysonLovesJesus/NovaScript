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

const VEC2 = `
  struct Vec2 {
    x: num;
    y: num;

    plus(self, other: Vec2): Vec2 {
      Vec2 { x: self.x + other.x, y: self.y + other.y }
    }

    scale(self, k: num): Vec2 {
      Vec2 { x: self.x * k, y: self.y * k }
    }
  }
`;

describe('M4: struct methods', () => {
  it('emits methods on constructed objects', () => {
    const output = compile(`${VEC2}
      fn main() {
        let a = Vec2 { x: 1, y: 2 };
        let b = a.plus(Vec2 { x: 3, y: 4 });
        console.log(b.x, b.y);
      }
    `);
    expect(output).toContain('plus(other) {');
    expect(output).toContain('return Vec2((this.x + other.x), (this.y + other.y));');
  });

  it('rewrites arithmetic operators to struct methods', () => {
    const output = compile(`${VEC2}
      fn main() {
        let a = Vec2 { x: 1, y: 2 };
        let b = Vec2 { x: 3, y: 4 };
        let c = a + b;
        console.log(c.x);
      }
    `);
    expect(output).toContain('const c = a.plus(b);');
  });

  it('rejects operators without a matching method', () => {
    expect(errors(`${VEC2}
      fn main() {
        let a = Vec2 { x: 1, y: 2 };
        let b = a - a;
      }
    `)).toContain("does not define 'minus'");
  });

  it('rewrites UFCS calls to free functions', () => {
    const output = compile(`${VEC2}
      fn norm(v: Vec2): num {
        v.x * v.x + v.y * v.y
      }
      fn main() {
        let a = Vec2 { x: 3, y: 4 };
        console.log(a.norm());
      }
    `);
    expect(output).toContain('norm(a)');
  });

  it('prefers struct methods over UFCS', () => {
    const output = compile(`${VEC2}
      fn plus(v: Vec2): num { v.x }
      fn main() {
        let a = Vec2 { x: 1, y: 2 };
        let b = a.plus(a);
        console.log(b.x);
      }
    `);
    expect(output).toContain('a.plus(a)');
  });

  it('rejects UFCS with no candidate', () => {
    expect(errors(`${VEC2}
      fn main() {
        let a = Vec2 { x: 1, y: 2 };
        a.fly();
      }
    `)).toContain("no method 'fly'");
  });

  it('type-checks method arguments', () => {
    expect(errors(`${VEC2}
      fn main() {
        let a = Vec2 { x: 1, y: 2 };
        a.scale("big");
      }
    `)).toContain('expected num, got str');
  });
});
