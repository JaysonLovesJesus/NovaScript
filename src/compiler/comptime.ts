// Comptime evaluation pass: runs after the checker. Calls from runtime code
// to comptime functions are evaluated now and replaced with the resulting
// literal, so the generated JS contains only baked constants.

import type { Program, Expr, Stmt, Block, FunctionDecl } from './ast.js';
import { Interpreter, ComptimeError, Value } from './interpreter.js';

export { ComptimeError } from './interpreter.js';

export function evaluateComptime(program: Program): void {
  const comptimeFns = new Map<string, FunctionDecl>();
  for (const decl of program.declarations) {
    if (decl.kind === 'function' && decl.isComptime) comptimeFns.set(decl.name, decl);
  }
  if (comptimeFns.size === 0) return;

  const interpreter = new Interpreter(comptimeFns);

  const transform = (e: Expr): Expr => {
    switch (e.kind) {
      case 'literal': case 'identifier': case 'unsafe_expr':
        return e;
      case 'binary': e.left = transform(e.left); e.right = transform(e.right); return e;
      case 'unary': e.operand = transform(e.operand); return e;
      case 'call': {
        e.callee = transform(e.callee);
        e.args = e.args.map(transform);
        if (e.callee.kind === 'identifier' && comptimeFns.has(e.callee.name)) {
          const fn = comptimeFns.get(e.callee.name)!;
          const args = e.args.map(a => {
            try {
              return interpreter.evalExpr(a, new Map());
            } catch (err) {
              if (err instanceof ComptimeError) {
                throw new ComptimeError(`Call to comptime fn ${fn.name} requires constant arguments: ${err.message}`);
              }
              throw err;
            }
          });
          return valueToExpr(interpreter.callFunction(fn, args));
        }
        return e;
      }
      case 'member': e.object = transform(e.object); return e;
      case 'index': e.object = transform(e.object); e.index = transform(e.index); return e;
      case 'array': e.elements = e.elements.map(transform); return e;
      case 'tuple_expr': e.elements = e.elements.map(transform); return e;
      case 'object': e.fields.forEach(f => { f.value = transform(f.value); }); return e;
      case 'range': e.start = transform(e.start); e.end = transform(e.end); return e;
      case 'template':
        e.parts.forEach(p => { if (p.kind === 'expr') p.expr = transform(p.expr); });
        return e;
      case 'postfix':
        e.expr = transform(e.expr);
        if (e.arg) e.arg = transform(e.arg);
        return e;
      case 'match':
        e.expr = transform(e.expr);
        e.arms.forEach(a => {
          if (a.guard) a.guard = transform(a.guard);
          transformBlock(a.body);
        });
        return e;
    }
  };

  const transformStmt = (s: Stmt): void => {
    switch (s.kind) {
      case 'let': s.init = transform(s.init); break;
      case 'return': if (s.value) s.value = transform(s.value); break;
      case 'expr': s.expr = transform(s.expr); break;
      case 'if':
        s.cond = transform(s.cond);
        transformBlock(s.thenBranch);
        if (s.elseBranch) s.elseBranch.kind === 'if' ? transformStmt(s.elseBranch) : transformBlock(s.elseBranch);
        break;
      case 'while': s.cond = transform(s.cond); transformBlock(s.body); break;
      case 'for': s.iterable = transform(s.iterable); transformBlock(s.body); break;
      case 'block': transformBlock(s); break;
      case 'unsafe': break;
    }
  };

  const transformBlock = (b: Block): void => b.statements.forEach(transformStmt);

  for (const decl of program.declarations) {
    if (decl.kind === 'function' && !decl.isComptime) transformBlock(decl.body);
    else if (decl.kind === 'struct') decl.methods.forEach(m => transformBlock(m.body));
  }
  for (const stmt of program.statements) {
    if (stmt.kind !== 'import') transformStmt(stmt);
  }
}

function valueToExpr(value: Value): Expr {
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return { kind: 'literal', value };
  }
  if (Array.isArray(value)) {
    return { kind: 'array', elements: value.map(valueToExpr) };
  }
  return {
    kind: 'object',
    fields: Object.entries(value).map(([name, v]) => ({ name, value: valueToExpr(v) })),
  };
}
