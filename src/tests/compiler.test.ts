import { describe, it, expect } from 'vitest';
import { compile, parse, tokenize } from '../compiler/index.js';

describe('NovaScript Compiler', () => {
  describe('Lexer', () => {
    it('tokenizes numbers', () => {
      const tokens = tokenize('42');
      expect(tokens[0].type).toBe('NUMBER');
      expect(tokens[0].value).toBe('42');
    });

    it('tokenizes strings', () => {
      const tokens = tokenize('"hello"');
      expect(tokens[0].type).toBe('STRING');
      expect(tokens[0].value).toBe('hello');
    });

    it('tokenizes keywords', () => {
      const tokens = tokenize('let fn return');
      expect(tokens[0].type).toBe('LET');
      expect(tokens[1].type).toBe('FN');
      expect(tokens[2].type).toBe('RETURN');
    });

    it('tokenizes operators', () => {
      const tokens = tokenize('+ - * / == != < > <= >= && ||');
      expect(tokens.map(t => t.type)).toEqual([
        'PLUS', 'MINUS', 'STAR', 'SLASH',
        'EQEQ', 'NEQ', 'LT', 'GT', 'LTE', 'GTE',
        'AND', 'OR', 'EOF'
      ]);
    });
  });

  describe('Parser', () => {
    it('parses a simple function', () => {
      const source = `
        fn add(a: num, b: num): num {
          a + b
        }
      `;
      const ast = parse(source);
      expect(ast.declarations[0].kind).toBe('function');
    });

    it('parses let statements', () => {
      const source = `
        let x = 5;
        let mut y = 10;
      `;
      const ast = parse(source);
      expect(ast.statements[0].kind).toBe('let');
      expect(ast.statements[1].kind).toBe('let');
    });

    it('parses binary expressions', () => {
      const source = '1 + 2 * 3';
      const ast = parse(source);
      expect(ast.statements[0]).toBeDefined();
    });
  });

  describe('Code Generation', () => {
    it('generates hello world', () => {
      const source = `
        fn main() {
          console.log("Hello");
        }
      `;
      const output = compile(source);
      expect(output).toContain('function main()');
      expect(output).toContain('console.log("Hello")');
    });

    it('generates function with parameters', () => {
      const source = `
        fn add(a: num, b: num): num {
          a + b
        }
      `;
      const output = compile(source);
      expect(output).toContain('function add(a, b)');
      expect(output).toContain('(a + b)');
    });

    it('generates immutable and mutable bindings', () => {
      const source = `
        let x = 5;
        let mut y = 10;
      `;
      const output = compile(source);
      expect(output).toContain('const x = 5');
      expect(output).toContain('let y = 10');
    });

    it('generates if/else', () => {
      const source = `
        if (x > 5) {
          x
        } else {
          0
        }
      `;
      const output = compile(source);
      expect(output).toContain('if ((x > 5))');
      expect(output).toContain('} else {');
    });

    it('generates while loop', () => {
      const source = `
        while (x < 10) {
          x + 1
        }
      `;
      const output = compile(source);
      expect(output).toContain('while ((x < 10))');
    });

    it('generates struct constructor', () => {
      const source = `
        struct Vec2 {
          x: num;
          y: num;
        }
      `;
      const output = compile(source);
      expect(output).toContain('// Vec2 struct');
      expect(output).toContain('function Vec2(x, y)');
    });

    it('generates enum variants', () => {
      const source = `
        enum Option<T> {
          Some(T),
          None
        }
      `;
      const output = compile(source);
      expect(output).toContain('// Option enum');
      expect(output).toContain('function Option_Some(value)');
      expect(output).toContain('const Option_None = { tag: "None" }');
    });
  });

  describe('Postfix Operators', () => {
    it('handles .await', () => {
      const source = 'fetch(url).await';
      const output = compile(source);
      expect(output).toContain('await');
    });

    it('handles .try', () => {
      const source = 'result.try';
      const output = compile(source);
      expect(output).toContain('.tag === "Err"');
    });

    it('handles .unwrap_or', () => {
      const source = 'opt.unwrap_or(0)';
      const output = compile(source);
      expect(output).toContain('.tag === "None"');
    });
  });
});
