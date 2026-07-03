// Comptime interpreter: a tree-walk evaluator for the pure subset of
// NovaScript that may run at compile time. No unsafe, no I/O, no calls to
// non-comptime functions.

import type { Expr, Stmt, Block, FunctionDecl } from './ast.js';

export type Value = number | string | boolean | Value[] | { [key: string]: Value };

export class ComptimeError extends Error {}

const MAX_LOOP_ITERATIONS = 100_000;

class ReturnSignal {
  constructor(public value: Value | undefined) {}
}

export class Interpreter {
  constructor(private comptimeFns: Map<string, FunctionDecl>) {}

  callFunction(decl: FunctionDecl, args: Value[]): Value {
    if (args.length !== decl.params.length) {
      throw new ComptimeError(`comptime fn ${decl.name} expects ${decl.params.length} argument(s)`);
    }
    const env = new Map<string, Value>();
    decl.params.forEach((p, i) => env.set(p.name, args[i]));
    try {
      const result = this.execBlock(decl.body, env);
      return result ?? this.fail(`comptime fn ${decl.name} did not produce a value`);
    } catch (signal) {
      if (signal instanceof ReturnSignal) {
        return signal.value ?? this.fail(`comptime fn ${decl.name} returned no value`);
      }
      throw signal;
    }
  }

  // Returns the block's trailing expression value, if any
  private execBlock(block: Block, env: Map<string, Value>): Value | undefined {
    let result: Value | undefined;
    block.statements.forEach((stmt, i) => {
      result = this.execStmt(stmt, env, i === block.statements.length - 1);
    });
    return result;
  }

  private execStmt(stmt: Stmt, env: Map<string, Value>, isLast: boolean): Value | undefined {
    switch (stmt.kind) {
      case 'let':
        env.set(stmt.name, this.evalExpr(stmt.init, env));
        return undefined;
      case 'return':
        throw new ReturnSignal(stmt.value ? this.evalExpr(stmt.value, env) : undefined);
      case 'expr':
        return isLast ? this.evalExpr(stmt.expr, env) : (this.evalExpr(stmt.expr, env), undefined);
      case 'if': {
        if (this.evalExpr(stmt.cond, env)) {
          return this.execBlock(stmt.thenBranch, env);
        }
        if (stmt.elseBranch) {
          return stmt.elseBranch.kind === 'if'
            ? this.execStmt(stmt.elseBranch, env, isLast)
            : this.execBlock(stmt.elseBranch, env);
        }
        return undefined;
      }
      case 'while': {
        let guard = 0;
        while (this.evalExpr(stmt.cond, env)) {
          if (++guard > MAX_LOOP_ITERATIONS) this.fail('comptime loop ran too long');
          this.execBlock(stmt.body, env);
        }
        return undefined;
      }
      case 'for': {
        const iterable = this.evalExpr(stmt.iterable, env);
        if (!Array.isArray(iterable)) this.fail('comptime for-in requires an array or range');
        let guard = 0;
        for (const item of iterable as Value[]) {
          if (++guard > MAX_LOOP_ITERATIONS) this.fail('comptime loop ran too long');
          env.set(stmt.varName, item);
          this.execBlock(stmt.body, env);
        }
        return undefined;
      }
      case 'block':
        return this.execBlock(stmt, env);
      case 'unsafe':
        this.fail('unsafe is not allowed in comptime code');
    }
  }

  evalExpr(expr: Expr, env: Map<string, Value>): Value {
    switch (expr.kind) {
      case 'literal':
        return expr.value;

      case 'identifier': {
        const value = env.get(expr.name);
        if (value === undefined) this.fail(`comptime: unknown identifier '${expr.name}'`);
        return value!;
      }

      case 'binary': {
        if (expr.op === '=') {
          if (expr.left.kind !== 'identifier') this.fail('comptime assignment target must be a variable');
          const value = this.evalExpr(expr.right, env);
          const name = (expr.left as { name: string }).name;
          if (!env.has(name)) this.fail(`comptime: unknown identifier '${name}'`);
          env.set(name, value);
          return value;
        }
        const l = this.evalExpr(expr.left, env);
        const r = this.evalExpr(expr.right, env);
        switch (expr.op) {
          case '+': return (l as number) + (r as number);
          case '-': return (l as number) - (r as number);
          case '*': return (l as number) * (r as number);
          case '/': return (l as number) / (r as number);
          case '%': return (l as number) % (r as number);
          case '<': return (l as number) < (r as number);
          case '>': return (l as number) > (r as number);
          case '<=': return (l as number) <= (r as number);
          case '>=': return (l as number) >= (r as number);
          case '==': return l === r;
          case '!=': return l !== r;
          case '&&': return Boolean(l) && Boolean(r);
          case '||': return Boolean(l) || Boolean(r);
        }
        this.fail(`comptime: unsupported operator '${expr.op}'`);
        break;
      }

      case 'unary': {
        const v = this.evalExpr(expr.operand, env);
        return expr.op === '-' ? -(v as number) : !(v as boolean);
      }

      case 'call': {
        // array.push is the one built-in method comptime code needs
        if (expr.callee.kind === 'member') {
          const target = this.evalExpr(expr.callee.object, env);
          if (Array.isArray(target) && expr.callee.property === 'push') {
            const args = expr.args.map(a => this.evalExpr(a, env));
            target.push(...args);
            return target.length;
          }
          this.fail(`comptime: unsupported method '${expr.callee.property}'`);
        }
        if (expr.callee.kind === 'identifier') {
          const fn = this.comptimeFns.get(expr.callee.name);
          if (!fn) this.fail(`comptime code can only call comptime functions, not '${expr.callee.name}'`);
          const args = expr.args.map(a => this.evalExpr(a, env));
          return this.callFunction(fn!, args);
        }
        this.fail('comptime: unsupported call expression');
        break;
      }

      case 'member': {
        const obj = this.evalExpr(expr.object, env);
        if ((Array.isArray(obj) || typeof obj === 'string') && expr.property === 'length') {
          return (obj as Value[] | string).length;
        }
        if (obj !== null && typeof obj === 'object' && !Array.isArray(obj) && expr.property in obj) {
          return (obj as Record<string, Value>)[expr.property];
        }
        this.fail(`comptime: cannot access '.${expr.property}'`);
        break;
      }

      case 'index': {
        const obj = this.evalExpr(expr.object, env);
        const idx = this.evalExpr(expr.index, env);
        if (Array.isArray(obj)) return (obj as Value[])[idx as number];
        if (typeof obj === 'string') return obj[idx as number];
        this.fail('comptime: cannot index this value');
        break;
      }

      case 'array':
        return expr.elements.map(e => this.evalExpr(e, env));

      case 'range': {
        const start = this.evalExpr(expr.start, env) as number;
        const end = this.evalExpr(expr.end, env) as number;
        if (end - start > MAX_LOOP_ITERATIONS) this.fail('comptime range too large');
        return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);
      }

      case 'template':
        return expr.parts.map(p => p.kind === 'text' ? p.value : String(this.evalExpr(p.expr, env))).join('');

      case 'object': {
        const out: Record<string, Value> = {};
        for (const f of expr.fields) out[f.name] = this.evalExpr(f.value, env);
        return out;
      }

      case 'tuple_expr':
        return expr.elements.map(e => this.evalExpr(e, env));

      case 'unsafe_expr':
        this.fail('unsafe is not allowed in comptime code');
        break;

      case 'postfix':
      case 'match':
        this.fail(`comptime: ${expr.kind} expressions are not supported yet`);
    }
    throw new ComptimeError('unreachable');
  }

  private fail(message: string): never {
    throw new ComptimeError(message);
  }
}
