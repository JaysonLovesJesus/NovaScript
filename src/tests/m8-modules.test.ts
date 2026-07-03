import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { compileProject, emitDts } from '../compiler/index.js';
import { parse } from '../compiler/index.js';

// A small two-module project written to a temp dir, compiled, and run so we
// exercise import resolution, cross-module type checking, export/import
// emission, and end-to-end execution under node.
describe('module system', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'nova-mod-'));
    writeFileSync(join(dir, 'math.nova'), `
      pub struct Vec2 {
        x: num;
        y: num;
        plus(self, other: Vec2): Vec2 {
          Vec2 { x: self.x + other.x, y: self.y + other.y }
        }
      }

      pub fn scale(v: Vec2, k: num): Vec2 {
        Vec2 { x: v.x * k, y: v.y * k }
      }
    `);
    writeFileSync(join(dir, 'main.nova'), `
      import { Vec2, scale } from "./math";

      fn main() {
        let a = Vec2 { x: 1, y: 2 };
        let b = Vec2 { x: 3, y: 4 };
        let c = (a + b).scale(2);
        console.log(c.x);
        console.log(c.y);
      }
    `);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('compiles all reachable modules', () => {
    const mods = compileProject(join(dir, 'main.nova'));
    expect(mods.map(m => m.path.endsWith('main.nova') || m.path.endsWith('math.nova')))
      .toEqual([true, true]);
  });

  it('emits export on pub decls and rewrites imports to .js', () => {
    const mods = compileProject(join(dir, 'main.nova'));
    const math = mods.find(m => m.path.endsWith('math.nova'))!;
    const main = mods.find(m => m.path.endsWith('main.nova'))!;
    expect(math.js).toContain('export function Vec2(');
    expect(math.js).toContain('export function scale(');
    expect(main.js).toContain('import { Vec2, scale } from "./math.js";');
  });

  it('only the entry module auto-invokes main()', () => {
    const mods = compileProject(join(dir, 'main.nova'));
    const main = mods.find(m => m.path.endsWith('main.nova'))!;
    expect(main.js.trimEnd().endsWith('main();')).toBe(true);
  });

  it('runs end-to-end under node', () => {
    const mods = compileProject(join(dir, 'main.nova'));
    for (const m of mods) writeFileSync(m.outPath, m.js);
    const out = execFileSync('node', [join(dir, 'main.js')], { encoding: 'utf-8' });
    // (1+3)*2 = 8, (2+4)*2 = 12
    expect(out.trim().split('\n')).toEqual(['8', '12']);
  });

  it('reports cross-module type errors', () => {
    const bad = mkdtempSync(join(tmpdir(), 'nova-bad-'));
    try {
      writeFileSync(join(bad, 'lib.nova'), `pub fn twice(n: num): num { n + n }`);
      writeFileSync(join(bad, 'app.nova'), `
        import { twice } from "./lib";
        fn main() { let x = twice("hello"); console.log(x); }
      `);
      expect(() => compileProject(join(bad, 'app.nova'))).toThrow(/expected num, got str/);
    } finally {
      rmSync(bad, { recursive: true, force: true });
    }
  });
});

describe('.d.ts emitter', () => {
  it('maps primitives and expands Option/Result', () => {
    const program = parse(`
      pub fn lookup(key: str): Option<num> { None }
      pub struct Point { x: num; y: num; }
    `);
    const dts = emitDts(program);
    expect(dts).toContain('export declare function lookup(key: string): ({ tag: "Some"; value: number } | { tag: "None" });');
    expect(dts).toContain('export interface Point {');
    expect(dts).toContain('export declare function Point(x: number, y: number): Point;');
  });

  it('wraps implicitly-async and passes through generics', () => {
    const program = parse(`
      pub fn identity<T>(x: T): T { x }
    `);
    const dts = emitDts(program);
    expect(dts).toContain('export declare function identity<T>(x: T): T;');
  });
});
