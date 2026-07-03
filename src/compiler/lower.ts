// AST lowering: rewrites .try and ? postfix operators into statement-level
// early returns. An IIFE cannot `return` from its enclosing function, so
//
//   let n = parse(s).try;
//
// becomes
//
//   const __try1 = parse(s);
//   if (__try1.tag === "Err") { return __try1; }
//   const n = __try1.value;
//
// Runs after the checker (which guarantees the enclosing function returns
// Result/Option) and before codegen.

import type { Program, Expr, Stmt, Block, IfStmt } from './ast.js';

export class LowerError extends Error {}

export function lower(program: Program): void {
  const l = new Lowerer();
  for (const decl of program.declarations) {
    if (decl.kind === 'function') l.lowerBlock(decl.body, false);
    else if (decl.kind === 'struct') decl.methods.forEach(m => l.lowerBlock(m.body, false));
  }
  const lowered = l.lowerStmts(
    program.statements.filter((s): s is Stmt => s.kind !== 'import'),
    false,
  );
  const imports = program.statements.filter(s => s.kind === 'import');
  program.statements = [...imports, ...lowered];
}

class Lowerer {
  private tempCounter = 0;

  lowerBlock(block: Block, inMatchArm: boolean): void {
    block.statements = this.lowerStmts(block.statements, inMatchArm);
  }

  lowerStmts(stmts: Stmt[], inMatchArm: boolean): Stmt[] {
    const out: Stmt[] = [];
    for (const stmt of stmts) {
      const hoists: Stmt[] = [];
      switch (stmt.kind) {
        case 'let':
          stmt.init = this.transform(stmt.init, hoists, inMatchArm);
          break;
        case 'expr':
          // A match whose value is discarded compiles to an if/else chain, so
          // its arms may early-return (via .try/?) into the enclosing function
          if (stmt.expr.kind === 'match' && !inMatchArm) {
            stmt.expr.stmtPosition = true;
            stmt.expr.expr = this.transform(stmt.expr.expr, hoists, inMatchArm);
            for (const arm of stmt.expr.arms) {
              if (arm.guard && containsTryOrQuestion(arm.guard)) {
                throw new LowerError('.try and ? are not supported in match guards');
              }
              this.lowerBlock(arm.body, false);
            }
          } else {
            stmt.expr = this.transform(stmt.expr, hoists, inMatchArm);
          }
          break;
        case 'return':
          if (stmt.value) stmt.value = this.transform(stmt.value, hoists, inMatchArm);
          break;
        case 'if':
          this.lowerIf(stmt, hoists, inMatchArm);
          break;
        case 'while':
          if (containsTryOrQuestion(stmt.cond)) {
            throw new LowerError('.try and ? are not supported in while conditions — bind the value before the loop');
          }
          this.lowerBlock(stmt.body, inMatchArm);
          break;
        case 'for':
          stmt.iterable = this.transform(stmt.iterable, hoists, inMatchArm);
          this.lowerBlock(stmt.body, inMatchArm);
          break;
        case 'block':
          this.lowerBlock(stmt, inMatchArm);
          break;
        case 'unsafe':
          break;
      }
      out.push(...hoists, stmt);
    }
    return out;
  }

  private lowerIf(stmt: IfStmt, hoists: Stmt[], inMatchArm: boolean): void {
    stmt.cond = this.transform(stmt.cond, hoists, inMatchArm);
    this.lowerBlock(stmt.thenBranch, inMatchArm);
    if (!stmt.elseBranch) return;
    if (stmt.elseBranch.kind === 'block') {
      this.lowerBlock(stmt.elseBranch, inMatchArm);
      return;
    }
    // else-if: if its condition needs hoisting, the hoists must run only
    // when the outer condition failed — wrap the chain in an else block
    if (containsTryOrQuestion(stmt.elseBranch.cond)) {
      const wrapped: Block = { kind: 'block', statements: [stmt.elseBranch] };
      stmt.elseBranch = wrapped;
      this.lowerBlock(wrapped, inMatchArm);
    } else {
      this.lowerIf(stmt.elseBranch, hoists, inMatchArm);
    }
  }

  private transform(e: Expr, hoists: Stmt[], inMatchArm: boolean): Expr {
    switch (e.kind) {
      case 'literal':
      case 'identifier':
      case 'unsafe_expr':
        return e;

      case 'binary':
        e.left = this.transform(e.left, hoists, inMatchArm);
        e.right = this.transform(e.right, hoists, inMatchArm);
        return e;

      case 'unary':
        e.operand = this.transform(e.operand, hoists, inMatchArm);
        return e;

      case 'call':
        e.callee = this.transform(e.callee, hoists, inMatchArm);
        e.args = e.args.map(a => this.transform(a, hoists, inMatchArm));
        return e;

      case 'member':
        e.object = this.transform(e.object, hoists, inMatchArm);
        return e;

      case 'index':
        e.object = this.transform(e.object, hoists, inMatchArm);
        e.index = this.transform(e.index, hoists, inMatchArm);
        return e;

      case 'array':
        e.elements = e.elements.map(el => this.transform(el, hoists, inMatchArm));
        return e;

      case 'tuple_expr':
        e.elements = e.elements.map(el => this.transform(el, hoists, inMatchArm));
        return e;

      case 'object':
        e.fields.forEach(f => { f.value = this.transform(f.value, hoists, inMatchArm); });
        return e;

      case 'range':
        e.start = this.transform(e.start, hoists, inMatchArm);
        e.end = this.transform(e.end, hoists, inMatchArm);
        return e;

      case 'template':
        e.parts.forEach(p => {
          if (p.kind === 'expr') p.expr = this.transform(p.expr, hoists, inMatchArm);
        });
        return e;

      case 'match':
        e.expr = this.transform(e.expr, hoists, inMatchArm);
        for (const arm of e.arms) {
          if (arm.guard && containsTryOrQuestion(arm.guard)) {
            throw new LowerError('.try and ? are not supported in match guards');
          }
          this.lowerBlock(arm.body, true);
        }
        return e;

      case 'postfix': {
        e.expr = this.transform(e.expr, hoists, inMatchArm);
        if (e.arg) e.arg = this.transform(e.arg, hoists, inMatchArm);

        if (e.op === '.try' || e.op === '?') {
          if (inMatchArm) {
            throw new LowerError(`${e.op} is not supported inside match arms — extract the arm body into a function`);
          }
          const tmp = `__t${++this.tempCounter}`;
          const tmpRef = (): Expr => ({ kind: 'identifier', name: tmp });
          const failTag = e.op === '.try' ? 'Err' : 'None';
          const failValue: Expr = e.op === '.try' ? tmpRef() : { kind: 'identifier', name: 'None' };
          hoists.push({ kind: 'let', mutable: false, name: tmp, init: e.expr });
          hoists.push({
            kind: 'if',
            cond: {
              kind: 'binary',
              left: { kind: 'member', object: tmpRef(), property: 'tag' },
              op: '===',
              right: { kind: 'literal', value: failTag },
            },
            thenBranch: { kind: 'block', statements: [{ kind: 'return', value: failValue }] },
          });
          return { kind: 'member', object: tmpRef(), property: 'value' };
        }
        return e;
      }
    }
  }
}

function containsTryOrQuestion(e: Expr): boolean {
  switch (e.kind) {
    case 'literal': case 'identifier': case 'unsafe_expr': return false;
    case 'binary': return containsTryOrQuestion(e.left) || containsTryOrQuestion(e.right);
    case 'unary': return containsTryOrQuestion(e.operand);
    case 'call': return containsTryOrQuestion(e.callee) || e.args.some(containsTryOrQuestion);
    case 'member': return containsTryOrQuestion(e.object);
    case 'index': return containsTryOrQuestion(e.object) || containsTryOrQuestion(e.index);
    case 'array': return e.elements.some(containsTryOrQuestion);
    case 'tuple_expr': return e.elements.some(containsTryOrQuestion);
    case 'object': return e.fields.some(f => containsTryOrQuestion(f.value));
    case 'range': return containsTryOrQuestion(e.start) || containsTryOrQuestion(e.end);
    case 'template': return e.parts.some(p => p.kind === 'expr' && containsTryOrQuestion(p.expr));
    case 'match': return containsTryOrQuestion(e.expr); // arm bodies handled separately
    case 'postfix':
      return e.op === '.try' || e.op === '?'
        || containsTryOrQuestion(e.expr)
        || (e.arg ? containsTryOrQuestion(e.arg) : false);
  }
}
