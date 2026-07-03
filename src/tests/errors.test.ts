import { describe, it, expect } from 'vitest';
import { compile } from '../compiler/index.js';
import { CompileError } from '../compiler/render.js';
import { renderCodeFrame } from '../compiler/render.js';

// Errors should carry a source position and render a caret under the offending
// token so the message is actionable, not just a bare string.
describe('code-frame errors', () => {
  function frameOf(source: string): string {
    try {
      compile(source, { file: 'test.nova' });
    } catch (e) {
      expect(e).toBeInstanceOf(CompileError);
      return (e as CompileError).message;
    }
    throw new Error('expected compile to throw');
  }

  it('points at the mistyped argument in a type error', () => {
    const frame = frameOf(`
      fn twice(n: num): num { n + n }
      fn main() { let x = twice("hi"); }
    `);
    expect(frame).toContain('expected num, got str');
    expect(frame).toContain('test.nova:3');
    const caretLine = frame.split('\n').find(l => l.includes('^'))!;
    // caret sits under the string literal, well past column 1
    expect(caretLine.indexOf('^')).toBeGreaterThan(4);
  });

  it('frames a parse error with position', () => {
    const frame = frameOf(`fn main() { let x = 3 +; }`);
    expect(frame).toContain('test.nova:1');
    expect(frame).toContain('^');
  });

  it('frames a lexer error', () => {
    const frame = frameOf(`fn main() { let s = "unterminated; }`);
    expect(frame).toMatch(/error:/);
    expect(frame).toContain('^');
  });

  it('renders a bare message when no position is available', () => {
    const out = renderCodeFrame('x', undefined, undefined, 'something went wrong');
    expect(out).toBe('error: something went wrong');
  });

  it('aligns the caret under the target column', () => {
    const out = renderCodeFrame('let x = 10;', 1, 9, 'here', { file: 'a.nova' });
    const lines = out.split('\n');
    const srcLine = lines[lines.length - 2];
    const caretLine = lines[lines.length - 1];
    // both lines share an identical "N │ " prefix, so the caret index equals
    // the source-text start plus (column - 1) → under the "1" of 10
    const textStart = srcLine.indexOf('│') + 2;
    expect(caretLine.indexOf('^')).toBe(textStart + (9 - 1));
    expect(srcLine[textStart + (9 - 1)]).toBe('1');
  });
});
