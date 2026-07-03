// Type checker for NovaScript.
//
// Two passes: (1) collect top-level signatures (structs, enums, functions,
// prelude), (2) check every function body and top-level statement with full
// inference. Generic calls are typed by unifying parameter types against
// argument types. The checker also resolves operator overloads and UFCS
// calls, marking the AST for the lowering pass, and infers implicit async.

import type {
  Program, Expr, Stmt, Block, FunctionDecl, StructDecl, EnumDecl,
  Pattern, MatchExpr, LetStmt, ImportStmt, TypeAnnotation, SourceLoc,
} from './ast.js';
import {
  Type, Substitution, NUM, STR, BOOL, VOID, UNKNOWN,
  typeToString, substitute, unify, typesCompatible,
} from './types.js';
import { Diagnostic, CheckError } from './diagnostics.js';
import { PRELUDE_ENUMS } from './prelude.js';
import { MATH_BUILTINS } from './builtins.js';

export interface CheckOptions {
  prelude?: boolean;
  /**
   * Declarations imported from other modules. Registered into the type
   * environment so imported structs/enums/functions get real types, but not
   * re-checked or re-emitted here.
   */
  externals?: (StructDecl | EnumDecl | FunctionDecl)[];
}

interface VarInfo {
  type: Type;
  mutable: boolean;
  unsafeOnly?: boolean;
}

interface FnSig {
  typeParams: string[];
  params: Type[];
  ret: Type;
  isAsync: boolean;
  isComptime: boolean;
  decl?: FunctionDecl;
}

interface VariantInfo {
  enumName: string;
  variantName: string;
  fieldTypes: Type[]; // in terms of the enum's typevars
}

const OVERLOAD_METHODS: Record<string, string> = {
  '+': 'plus',
  '-': 'minus',
  '*': 'times',
  '/': 'div',
};

class Scope {
  private vars = new Map<string, VarInfo>();
  constructor(private parent?: Scope) {}

  lookup(name: string): VarInfo | undefined {
    return this.vars.get(name) ?? this.parent?.lookup(name);
  }

  declare(name: string, info: VarInfo): void {
    this.vars.set(name, info);
  }
}

interface FnContext {
  name: string;
  ret: Type;
  typeParams: string[];
  inUnsafe: boolean;
  /** Set to true when a `.await` is checked in this scope (for closure async). */
  sawAwait?: boolean;
}

export class Checker {
  private diagnostics: Diagnostic[] = [];
  private structs = new Map<string, StructDecl>();
  private enums = new Map<string, EnumDecl>();
  private fns = new Map<string, FnSig>();
  private variantCtors = new Map<string, VariantInfo>(); // "Option_Some", plus bare "Some" for the prelude
  private globals = new Scope();
  private context = 'top level';
  private locs?: WeakMap<object, SourceLoc>;
  /** The node currently being checked; error() reads its source position. */
  private currentNode?: object;

  check(program: Program, options: CheckOptions = {}): void {
    const usePrelude = options.prelude !== false;
    this.locs = program.locs;

    // Pass 1: collect signatures
    if (usePrelude) {
      for (const e of PRELUDE_ENUMS) this.collectEnum(e, true);
    }
    // Imported types first so own decls and function signatures can reference them
    const externals = options.externals ?? [];
    for (const decl of externals) {
      if (decl.kind === 'struct') this.structs.set(decl.name, decl);
      else if (decl.kind === 'enum') this.collectEnum(decl, false);
    }
    for (const decl of program.declarations) {
      if (decl.kind === 'struct') {
        if (this.structs.has(decl.name)) this.error(`Duplicate struct '${decl.name}'`);
        this.structs.set(decl.name, decl);
      } else if (decl.kind === 'enum') {
        this.collectEnum(decl, false);
      }
    }
    for (const decl of externals) {
      if (decl.kind === 'function') {
        this.markAsyncIfAwaits(decl);
        this.fns.set(decl.name, this.functionSig(decl));
      }
    }
    for (const decl of program.declarations) {
      if (decl.kind === 'function') {
        if (this.fns.has(decl.name)) this.error(`Duplicate function '${decl.name}'`);
        this.markAsyncIfAwaits(decl);
        this.fns.set(decl.name, this.functionSig(decl));
      }
    }

    // Builtin interop globals: typed unknown, checked loosely
    for (const builtin of ['console', 'Math', 'JSON']) {
      this.globals.declare(builtin, { type: UNKNOWN, mutable: false });
    }
    // The unit value `()` lowers to `undefined` and has type void
    this.globals.declare('undefined', { type: VOID, mutable: false });

    // Built-in math free functions (compile to Math.* in codegen)
    for (const [name, b] of Object.entries(MATH_BUILTINS)) {
      if (!this.fns.has(name)) {
        this.fns.set(name, {
          typeParams: [], params: Array(b.arity).fill(NUM), ret: NUM,
          isAsync: false, isComptime: false,
        });
      }
    }

    // Imports register names; unsafe imports are usable only inside unsafe.
    // Names that resolve to an imported declaration (struct/enum/fn) are typed
    // through the type maps instead of an opaque UNKNOWN global.
    const externalNames = new Set(externals.map(d => d.name));
    for (const stmt of program.statements) {
      if (stmt.kind === 'import') {
        for (const name of stmt.names) {
          if (!stmt.isUnsafe && externalNames.has(name)) continue;
          this.globals.declare(name, { type: UNKNOWN, mutable: false, unsafeOnly: stmt.isUnsafe });
        }
      }
    }

    // Pass 2: top-level statements first so their bindings (e.g. baked
    // comptime constants) are visible inside function bodies
    this.context = 'top level';
    const topCtx: FnContext = { name: 'top level', ret: VOID, typeParams: [], inUnsafe: false };
    for (const stmt of program.statements) {
      if (stmt.kind !== 'import') this.checkStmt(stmt, this.globals, topCtx);
    }

    for (const decl of program.declarations) {
      if (decl.kind === 'function') this.checkFunction(decl);
      else if (decl.kind === 'struct') this.checkStructMethods(decl);
    }

    if (this.diagnostics.some(d => d.severity === 'error')) {
      throw new CheckError(this.diagnostics);
    }
  }

  private collectEnum(decl: EnumDecl, isPrelude: boolean): void {
    if (this.enums.has(decl.name)) {
      // A user re-declaration of Option/Result overrides the prelude
      if (!isPrelude) this.enums.set(decl.name, decl);
    } else {
      this.enums.set(decl.name, decl);
    }
    const typeParams = decl.typeParams ?? [];
    for (const variant of decl.variants) {
      const fieldTypes = (variant.fields ?? []).map(f => this.toType(f, typeParams));
      const info: VariantInfo = { enumName: decl.name, variantName: variant.name, fieldTypes };
      this.variantCtors.set(`${decl.name}_${variant.name}`, info);
      if (isPrelude) this.variantCtors.set(variant.name, info);
    }
  }

  private functionSig(decl: FunctionDecl): FnSig {
    const typeParams = decl.typeParams ?? [];
    return {
      typeParams,
      params: decl.params.map(p => this.toType(p.type, typeParams)),
      ret: this.toType(decl.returnType, typeParams),
      isAsync: decl.isAsync === true,
      isComptime: decl.isComptime,
      decl,
    };
  }

  // Implicit async: any .await in the body makes the function async
  private markAsyncIfAwaits(decl: FunctionDecl): void {
    let found = false;
    const visitExpr = (e: Expr): void => {
      if (found) return;
      switch (e.kind) {
        case 'postfix':
          if (e.op === '.await') { found = true; return; }
          visitExpr(e.expr);
          if (e.arg) visitExpr(e.arg);
          break;
        case 'binary': visitExpr(e.left); visitExpr(e.right); break;
        case 'unary': visitExpr(e.operand); break;
        case 'call': visitExpr(e.callee); e.args.forEach(visitExpr); break;
        case 'member': visitExpr(e.object); break;
        case 'index': visitExpr(e.object); visitExpr(e.index); break;
        case 'array': e.elements.forEach(visitExpr); break;
        case 'tuple_expr': e.elements.forEach(visitExpr); break;
        case 'object': e.fields.forEach(f => visitExpr(f.value)); break;
        case 'range': visitExpr(e.start); visitExpr(e.end); break;
        case 'template': e.parts.forEach(p => { if (p.kind === 'expr') visitExpr(p.expr); }); break;
        case 'match':
          visitExpr(e.expr);
          e.arms.forEach(a => { if (a.guard) visitExpr(a.guard); visitBlock(a.body); });
          break;
        case 'closure': break; // a closure's .await belongs to the closure, not this fn
        case 'unsafe_expr': break;
      }
    };
    const visitStmt = (s: Stmt): void => {
      if (found) return;
      switch (s.kind) {
        case 'let': visitExpr(s.init); break;
        case 'return': if (s.value) visitExpr(s.value); break;
        case 'expr': visitExpr(s.expr); break;
        case 'if':
          visitExpr(s.cond); visitBlock(s.thenBranch);
          if (s.elseBranch) s.elseBranch.kind === 'if' ? visitStmt(s.elseBranch) : visitBlock(s.elseBranch);
          break;
        case 'while': visitExpr(s.cond); visitBlock(s.body); break;
        case 'for': visitExpr(s.iterable); visitBlock(s.body); break;
        case 'block': visitBlock(s); break;
        case 'unsafe': break;
      }
    };
    const visitBlock = (b: Block): void => b.statements.forEach(visitStmt);
    visitBlock(decl.body);
    if (found) decl.isAsync = true;
  }

  // ---- annotation → semantic type ----

  private toType(ann: TypeAnnotation | undefined, typeParams: string[]): Type {
    if (!ann) return UNKNOWN;
    switch (ann.kind) {
      case 'num': return NUM;
      case 'str': return STR;
      case 'bool': return BOOL;
      case 'void': return VOID;
      case 'generic': return { kind: 'typevar', name: ann.name };
      case 'option':
        return { kind: 'enum', name: 'Option', typeArgs: [this.toType(ann.inner, typeParams)] };
      case 'result':
        return {
          kind: 'enum', name: 'Result',
          typeArgs: [this.toType(ann.ok, typeParams), this.toType(ann.err, typeParams)],
        };
      case 'array':
        return { kind: 'array', element: this.toType(ann.element, typeParams) };
      case 'function':
        return {
          kind: 'fn',
          params: ann.params.map(p => this.toType(p, typeParams)),
          ret: this.toType(ann.ret, typeParams),
        };
      case 'nominal': {
        if (typeParams.includes(ann.name)) return { kind: 'typevar', name: ann.name };
        if (this.structs.has(ann.name)) return { kind: 'struct', name: ann.name };
        if (this.enums.has(ann.name)) {
          const enumDecl = this.enums.get(ann.name)!;
          const declParams = enumDecl.typeParams ?? [];
          const args = ann.typeArgs?.map(a => this.toType(a, typeParams))
            ?? declParams.map(() => UNKNOWN);
          return { kind: 'enum', name: ann.name, typeArgs: args };
        }
        // Promise<T> from interop annotations
        if (ann.name === 'Promise') {
          return { kind: 'promise', inner: this.toType(ann.typeArgs?.[0], typeParams) };
        }
        this.error(`Unknown type '${ann.name}'`);
        return UNKNOWN;
      }
    }
  }

  // ---- declarations ----

  private checkFunction(decl: FunctionDecl, selfType?: Type, structTypeParams: string[] = []): void {
    const prevContext = this.context;
    this.context = selfType ? `method ${typeToString(selfType)}.${decl.name}` : `function ${decl.name}`;
    const typeParams = [...structTypeParams, ...(decl.typeParams ?? [])];
    const scope = new Scope(this.globals);
    if (selfType) scope.declare('self', { type: selfType, mutable: false });
    for (const p of decl.params) {
      scope.declare(p.name, { type: this.toType(p.type, typeParams), mutable: false });
    }
    const declaredRet = this.toType(decl.returnType, typeParams);
    // An async fn body yields T while the signature says Promise<T>; check the
    // body (and .try/? propagation, and `return`) against the unwrapped T.
    const ret = decl.isAsync && declaredRet.kind === 'promise' ? declaredRet.inner : declaredRet;
    const ctx: FnContext = { name: decl.name, ret, typeParams, inUnsafe: false };

    const valueType = this.checkBlockValue(decl.body, scope, ctx);
    if (ret.kind !== 'void' && ret.kind !== 'unknown') {
      if (!this.blockAlwaysReturns(decl.body) && !typesCompatible(ret, valueType)) {
        this.error(`Function '${decl.name}' should return ${typeToString(ret)} but its body produces ${typeToString(valueType)}`);
      }
    }
    this.context = prevContext;
  }

  private checkStructMethods(decl: StructDecl): void {
    const selfType: Type = { kind: 'struct', name: decl.name };
    for (const method of decl.methods) {
      this.markAsyncIfAwaits(method);
      this.checkFunction(method, selfType, decl.typeParams ?? []);
    }
  }

  // ---- statements ----

  private checkStmt(stmt: Stmt | ImportStmt, scope: Scope, ctx: FnContext): void {
    switch (stmt.kind) {
      case 'let': {
        const initType = this.checkExpr(stmt.init, scope, ctx);
        let varType = initType;
        if (stmt.typeAnnotation) {
          const annType = this.toType(stmt.typeAnnotation, ctx.typeParams);
          if (!typesCompatible(annType, initType)) {
            this.error(`Cannot assign ${typeToString(initType)} to '${stmt.name}: ${typeToString(annType)}'`);
          }
          varType = annType;
        }
        scope.declare(stmt.name, { type: varType, mutable: stmt.mutable });
        break;
      }
      case 'return': {
        const valueType = stmt.value ? this.checkExpr(stmt.value, scope, ctx) : VOID;
        if (!typesCompatible(ctx.ret, valueType)) {
          this.error(`Return type mismatch: expected ${typeToString(ctx.ret)}, got ${typeToString(valueType)}`);
        }
        break;
      }
      case 'if': {
        const condType = this.checkExpr(stmt.cond, scope, ctx);
        if (!typesCompatible(BOOL, condType)) {
          this.error(`Condition must be bool, got ${typeToString(condType)}`);
        }
        this.checkBlockValue(stmt.thenBranch, new Scope(scope), ctx);
        if (stmt.elseBranch) {
          if (stmt.elseBranch.kind === 'if') this.checkStmt(stmt.elseBranch, scope, ctx);
          else this.checkBlockValue(stmt.elseBranch, new Scope(scope), ctx);
        }
        break;
      }
      case 'while': {
        const condType = this.checkExpr(stmt.cond, scope, ctx);
        if (!typesCompatible(BOOL, condType)) {
          this.error(`Loop condition must be bool, got ${typeToString(condType)}`);
        }
        this.checkBlockValue(stmt.body, new Scope(scope), ctx);
        break;
      }
      case 'for': {
        const iterType = this.checkExpr(stmt.iterable, scope, ctx);
        let elemType: Type = UNKNOWN;
        if (iterType.kind === 'array') elemType = iterType.element;
        else if (iterType.kind === 'unknown') elemType = UNKNOWN;
        else this.error(`Cannot iterate over ${typeToString(iterType)}`);
        const bodyScope = new Scope(scope);
        bodyScope.declare(stmt.varName, { type: elemType, mutable: false });
        this.checkBlockValue(stmt.body, bodyScope, ctx);
        break;
      }
      case 'block':
        this.checkBlockValue(stmt, new Scope(scope), ctx);
        break;
      case 'expr':
        this.checkExpr(stmt.expr, scope, ctx);
        break;
      case 'unsafe':
        // Raw JS: contents are trusted verbatim
        break;
      case 'import':
        break;
    }
  }

  // A closure is its own function scope: params bind in a child scope, `.await`
  // makes only this closure async, and `.try`/`?`/`return` resolve against the
  // closure's return type. `expected` (when the closure is an argument to a
  // fn-typed parameter) supplies param and return types for inference.
  private checkClosure(
    expr: Extract<Expr, { kind: 'closure' }>, scope: Scope, ctx: FnContext, expected?: Type,
  ): Type {
    const expectedFn = expected?.kind === 'fn' ? expected : undefined;
    const closureScope = new Scope(scope);
    const paramTypes: Type[] = expr.params.map((p, i) => {
      const t = p.type ? this.toType(p.type, ctx.typeParams) : (expectedFn?.params[i] ?? UNKNOWN);
      closureScope.declare(p.name, { type: t, mutable: false });
      return t;
    });

    const bodyCtx: FnContext = {
      name: 'closure', ret: expectedFn?.ret ?? UNKNOWN,
      typeParams: ctx.typeParams, inUnsafe: ctx.inUnsafe, sawAwait: false,
    };
    const bodyType = expr.body.kind === 'block'
      ? this.checkBlockValue(expr.body, closureScope, bodyCtx)
      : this.checkExpr(expr.body, closureScope, bodyCtx);

    expr.isAsync = bodyCtx.sawAwait === true;
    // When the expected return type is known (and the closure isn't async, whose
    // body yields the unwrapped value), the body must actually produce it.
    const expectedRet = expectedFn?.ret;
    if (!expr.isAsync && expectedRet && expectedRet.kind !== 'unknown'
        && !typesCompatible(expectedRet, bodyType)) {
      this.error(`Closure returns ${typeToString(bodyType)} but ${typeToString(expectedRet)} is expected`);
    }
    const ret = expectedRet && expectedRet.kind !== 'unknown' ? expectedRet : bodyType;
    return { kind: 'fn', params: paramTypes, ret, isAsync: expr.isAsync };
  }

  // Type of the value a block evaluates to (its trailing expression)
  private checkBlockValue(block: Block, scope: Scope, ctx: FnContext): Type {
    let result: Type = VOID;
    block.statements.forEach((stmt, i) => {
      const isLast = i === block.statements.length - 1;
      if (isLast && stmt.kind === 'expr') {
        result = this.checkExpr(stmt.expr, scope, ctx);
      } else if (isLast && stmt.kind === 'if') {
        result = this.ifValueType(stmt, scope, ctx);
      } else {
        this.checkStmt(stmt, scope, ctx);
      }
    });
    return result;
  }

  private ifValueType(stmt: Extract<Stmt, { kind: 'if' }>, scope: Scope, ctx: FnContext): Type {
    const condType = this.checkExpr(stmt.cond, scope, ctx);
    if (!typesCompatible(BOOL, condType)) {
      this.error(`Condition must be bool, got ${typeToString(condType)}`);
    }
    const thenType = this.checkBlockValue(stmt.thenBranch, new Scope(scope), ctx);
    if (!stmt.elseBranch) return VOID;
    const elseType = stmt.elseBranch.kind === 'if'
      ? this.ifValueType(stmt.elseBranch, scope, ctx)
      : this.checkBlockValue(stmt.elseBranch, new Scope(scope), ctx);
    if (typesCompatible(thenType, elseType)) return thenType.kind === 'unknown' ? elseType : thenType;
    this.error(`if/else branches disagree: ${typeToString(thenType)} vs ${typeToString(elseType)}`);
    return thenType;
  }

  private blockAlwaysReturns(block: Block): boolean {
    const last = block.statements[block.statements.length - 1];
    if (!last) return false;
    if (last.kind === 'return') return true;
    if (last.kind === 'if') {
      let node: Stmt | Block | undefined = last;
      // every branch must return
      const branchReturns = (b: Block | Extract<Stmt, { kind: 'if' }>): boolean => {
        if (b.kind === 'block') return this.blockAlwaysReturns(b);
        if (!b.elseBranch) return false;
        return this.blockAlwaysReturns(b.thenBranch)
          && (b.elseBranch.kind === 'if' ? branchReturns(b.elseBranch) : this.blockAlwaysReturns(b.elseBranch));
      };
      return branchReturns(last);
    }
    return false;
  }

  // ---- expressions ----

  private checkExpr(expr: Expr, scope: Scope, ctx: FnContext): Type {
    this.currentNode = expr;
    switch (expr.kind) {
      case 'literal':
        if (typeof expr.value === 'number') return NUM;
        if (typeof expr.value === 'string') return STR;
        return BOOL;

      case 'identifier': {
        if (expr.name === '_') { this.error(`'_' is not a value`); return UNKNOWN; }
        const variable = scope.lookup(expr.name);
        if (variable) {
          if (variable.unsafeOnly && !ctx.inUnsafe) {
            this.error(`'${expr.name}' is an unsafe import and can only be used inside unsafe blocks`);
          }
          return variable.type;
        }
        const fn = this.fns.get(expr.name);
        if (fn) return { kind: 'fn', params: fn.params, ret: fn.ret, isAsync: fn.isAsync };
        const ctor = this.variantCtors.get(expr.name);
        if (ctor) {
          if (ctor.fieldTypes.length === 0) return this.variantValueType(ctor);
          this.error(`Constructor '${expr.name}' expects arguments`);
          return UNKNOWN;
        }
        this.error(`Unknown identifier '${expr.name}'`);
        return UNKNOWN;
      }

      case 'binary':
        return this.checkBinary(expr, scope, ctx);

      case 'unary': {
        const operandType = this.checkExpr(expr.operand, scope, ctx);
        if (expr.op === '-') {
          if (!typesCompatible(NUM, operandType)) this.error(`Unary '-' requires num, got ${typeToString(operandType)}`);
          return NUM;
        }
        if (!typesCompatible(BOOL, operandType)) this.error(`'!' requires bool, got ${typeToString(operandType)}`);
        return BOOL;
      }

      case 'call':
        return this.checkCall(expr, scope, ctx);

      case 'member':
        return this.checkMember(expr.object, expr.property, scope, ctx);

      case 'index': {
        const objType = this.checkExpr(expr.object, scope, ctx);
        const idxType = this.checkExpr(expr.index, scope, ctx);
        if (!typesCompatible(NUM, idxType)) this.error(`Index must be num, got ${typeToString(idxType)}`);
        if (objType.kind === 'array') return objType.element;
        if (objType.kind === 'str') return STR;
        if (objType.kind === 'unknown') return UNKNOWN;
        this.error(`Cannot index ${typeToString(objType)}`);
        return UNKNOWN;
      }

      case 'range': {
        const startType = this.checkExpr(expr.start, scope, ctx);
        const endType = this.checkExpr(expr.end, scope, ctx);
        if (!typesCompatible(NUM, startType) || !typesCompatible(NUM, endType)) {
          this.error('Range bounds must be num');
        }
        return { kind: 'array', element: NUM };
      }

      case 'tuple_expr':
        return { kind: 'tuple', elements: expr.elements.map(e => this.checkExpr(e, scope, ctx)) };

      case 'template':
        for (const part of expr.parts) {
          if (part.kind === 'expr') this.checkExpr(part.expr, scope, ctx);
        }
        return STR;

      case 'array': {
        if (expr.elements.length === 0) return { kind: 'array', element: UNKNOWN };
        const elemType = this.checkExpr(expr.elements[0], scope, ctx);
        for (const el of expr.elements.slice(1)) {
          const t = this.checkExpr(el, scope, ctx);
          if (!typesCompatible(elemType, t)) {
            this.error(`Array elements disagree: ${typeToString(elemType)} vs ${typeToString(t)}`);
          }
        }
        return { kind: 'array', element: elemType };
      }

      case 'object': {
        if (expr.typeName) {
          const struct = this.structs.get(expr.typeName);
          if (!struct) {
            this.error(`Unknown struct '${expr.typeName}'`);
            return UNKNOWN;
          }
          const given = new Map(expr.fields.map(f => [f.name, f.value]));
          for (const field of struct.fields) {
            const value = given.get(field.name);
            if (!value) {
              this.error(`Missing field '${field.name}' in ${expr.typeName} literal`);
              continue;
            }
            given.delete(field.name);
            const valueType = this.checkExpr(value, scope, ctx);
            const fieldType = this.toType(field.type, struct.typeParams ?? []);
            if (!typesCompatible(fieldType, valueType)) {
              this.error(`Field '${field.name}' of ${expr.typeName} is ${typeToString(fieldType)}, got ${typeToString(valueType)}`);
            }
          }
          for (const extra of given.keys()) {
            this.error(`Unknown field '${extra}' in ${expr.typeName} literal`);
          }
          return { kind: 'struct', name: expr.typeName };
        }
        for (const f of expr.fields) this.checkExpr(f.value, scope, ctx);
        return UNKNOWN;
      }

      case 'postfix':
        return this.checkPostfix(expr, scope, ctx);

      case 'unsafe_expr':
        // Raw JS: the compiler trusts it to produce the expected type
        return UNKNOWN;

      case 'closure':
        return this.checkClosure(expr, scope, ctx);

      case 'match':
        return this.checkMatch(expr, scope, ctx);
    }
  }

  private checkBinary(expr: Extract<Expr, { kind: 'binary' }>, scope: Scope, ctx: FnContext): Type {
    // Assignment parses as a binary '='
    if (expr.op === '=') {
      // Field/element assignment: check the target type; per-field mutability
      // tracking is future work
      if (expr.left.kind === 'member' || expr.left.kind === 'index') {
        const targetType = this.checkExpr(expr.left, scope, ctx);
        const rightType = this.checkExpr(expr.right, scope, ctx);
        if (!typesCompatible(targetType, rightType)) {
          this.error(`Cannot assign ${typeToString(rightType)} to a ${typeToString(targetType)} target`);
        }
        return VOID;
      }
      if (expr.left.kind !== 'identifier') {
        this.checkExpr(expr.left, scope, ctx);
        this.checkExpr(expr.right, scope, ctx);
        return VOID;
      }
      const variable = scope.lookup(expr.left.name);
      if (!variable) {
        this.error(`Unknown identifier '${expr.left.name}'`);
        this.checkExpr(expr.right, scope, ctx);
        return VOID;
      }
      if (!variable.mutable) {
        this.error(`Cannot assign to immutable '${expr.left.name}' — declare it with 'let mut'`);
      }
      const rightType = this.checkExpr(expr.right, scope, ctx);
      if (!typesCompatible(variable.type, rightType)) {
        this.error(`Cannot assign ${typeToString(rightType)} to '${expr.left.name}: ${typeToString(variable.type)}'`);
      }
      return VOID;
    }

    const leftType = this.checkExpr(expr.left, scope, ctx);
    const rightType = this.checkExpr(expr.right, scope, ctx);

    if (expr.op in OVERLOAD_METHODS && leftType.kind === 'struct') {
      const methodName = OVERLOAD_METHODS[expr.op];
      const method = this.findMethod(leftType.name, methodName);
      if (!method) {
        this.error(`Struct ${leftType.name} does not define '${methodName}' for operator '${expr.op}'`);
        return UNKNOWN;
      }
      if (method.params.length !== 1) {
        this.error(`Operator method ${leftType.name}.${methodName} must take exactly one parameter`);
      } else if (!typesCompatible(method.params[0], rightType)) {
        this.error(`Operator '${expr.op}': right operand is ${typeToString(rightType)}, ${leftType.name}.${methodName} expects ${typeToString(method.params[0])}`);
      }
      expr.overloadMethod = methodName;
      return method.ret;
    }

    switch (expr.op) {
      case '+':
        if (typesCompatible(STR, leftType) && typesCompatible(STR, rightType)) return STR;
        // fallthrough to numeric check
      case '-': case '*': case '/': case '%': {
        if (!typesCompatible(NUM, leftType) || !typesCompatible(NUM, rightType)) {
          this.error(`Operator '${expr.op}' requires num operands, got ${typeToString(leftType)} and ${typeToString(rightType)}`);
        }
        return NUM;
      }
      case '<': case '>': case '<=': case '>=':
        if (!typesCompatible(NUM, leftType) || !typesCompatible(NUM, rightType)) {
          this.error(`Comparison '${expr.op}' requires num operands, got ${typeToString(leftType)} and ${typeToString(rightType)}`);
        }
        return BOOL;
      case '==': case '!=':
        if (!typesCompatible(leftType, rightType)) {
          this.error(`Cannot compare ${typeToString(leftType)} with ${typeToString(rightType)}`);
        }
        return BOOL;
      case '&&': case '||':
        if (!typesCompatible(BOOL, leftType) || !typesCompatible(BOOL, rightType)) {
          this.error(`'${expr.op}' requires bool operands, got ${typeToString(leftType)} and ${typeToString(rightType)}`);
        }
        return BOOL;
      default:
        this.error(`Unknown operator '${expr.op}'`);
        return UNKNOWN;
    }
  }

  private checkCall(expr: Extract<Expr, { kind: 'call' }>, scope: Scope, ctx: FnContext): Type {
    // Method call or UFCS: obj.method(args)
    if (expr.callee.kind === 'member') {
      return this.checkMethodOrUfcsCall(expr, scope, ctx);
    }

    // Named call: function, variant constructor, or fn-typed variable
    if (expr.callee.kind === 'identifier') {
      const name = expr.callee.name;

      const ctor = this.variantCtors.get(name);
      if (ctor) {
        const argTypes = expr.args.map(a => this.checkExpr(a, scope, ctx));
        if (argTypes.length !== ctor.fieldTypes.length) {
          this.error(`${name} expects ${ctor.fieldTypes.length} argument(s), got ${argTypes.length}`);
          return this.variantValueType(ctor);
        }
        const subst: Substitution = new Map();
        ctor.fieldTypes.forEach((f, i) => {
          if (!unify(f, argTypes[i], subst)) {
            this.error(`${name} argument ${i + 1}: expected ${typeToString(f)}, got ${typeToString(argTypes[i])}`);
          }
        });
        return this.variantValueType(ctor, subst);
      }

      const fn = this.fns.get(name);
      if (fn) return this.checkInvocation(name, fn, expr.args, scope, ctx);

      const variable = scope.lookup(name);
      if (variable) {
        if (variable.unsafeOnly && !ctx.inUnsafe) {
          this.error(`'${name}' is an unsafe import and can only be used inside unsafe blocks`);
        }
        if (variable.type.kind === 'fn') {
          const sig: FnSig = { typeParams: [], params: variable.type.params, ret: variable.type.ret, isAsync: variable.type.isAsync === true, isComptime: false };
          return this.checkInvocation(name, sig, expr.args, scope, ctx);
        }
        if (variable.type.kind === 'unknown') {
          expr.args.forEach(a => this.checkExpr(a, scope, ctx));
          return UNKNOWN;
        }
        this.error(`'${name}' is not callable (${typeToString(variable.type)})`);
        expr.args.forEach(a => this.checkExpr(a, scope, ctx));
        return UNKNOWN;
      }

      this.error(`Unknown function '${name}'`);
      expr.args.forEach(a => this.checkExpr(a, scope, ctx));
      return UNKNOWN;
    }

    // Arbitrary callee expression
    const calleeType = this.checkExpr(expr.callee, scope, ctx);
    expr.args.forEach(a => this.checkExpr(a, scope, ctx));
    if (calleeType.kind === 'fn') return calleeType.ret;
    if (calleeType.kind === 'unknown') return UNKNOWN;
    this.error(`Expression of type ${typeToString(calleeType)} is not callable`);
    return UNKNOWN;
  }

  private checkMethodOrUfcsCall(expr: Extract<Expr, { kind: 'call' }>, scope: Scope, ctx: FnContext): Type {
    const callee = expr.callee as Extract<Expr, { kind: 'member' }>;
    const objType = this.checkExpr(callee.object, scope, ctx);

    if (objType.kind === 'struct') {
      const method = this.findMethod(objType.name, callee.property);
      if (method) {
        return this.checkInvocation(`${objType.name}.${callee.property}`, method, expr.args, scope, ctx);
      }
      // UFCS: fall back to a free function with the object as first argument
      const fn = this.fns.get(callee.property);
      if (fn && fn.params.length === expr.args.length + 1) {
        const subst: Substitution = new Map();
        if (unify(fn.params[0], objType, subst)) {
          expr.ufcs = true;
          const argTypes = expr.args.map(a => this.checkExpr(a, scope, ctx));
          argTypes.forEach((t, i) => {
            if (!unify(fn.params[i + 1], t, subst)) {
              this.error(`${callee.property} argument ${i + 1}: expected ${typeToString(substitute(fn.params[i + 1], subst))}, got ${typeToString(t)}`);
            }
          });
          return substitute(fn.ret, subst);
        }
      }
      this.error(`${objType.name} has no method '${callee.property}' and no matching free function for UFCS`);
      expr.args.forEach(a => this.checkExpr(a, scope, ctx));
      return UNKNOWN;
    }

    if (objType.kind === 'array' && callee.property === 'push') {
      // minimal built-in surface for arrays
      expr.args.forEach(a => this.checkExpr(a, scope, ctx));
      return VOID;
    }

    if (objType.kind === 'unknown' || objType.kind === 'promise') {
      expr.args.forEach(a => this.checkExpr(a, scope, ctx));
      return UNKNOWN;
    }

    this.error(`Type ${typeToString(objType)} has no method '${callee.property}'`);
    expr.args.forEach(a => this.checkExpr(a, scope, ctx));
    return UNKNOWN;
  }

  private checkInvocation(name: string, sig: FnSig, args: Expr[], scope: Scope, ctx: FnContext): Type {
    if (args.length !== sig.params.length) {
      this.error(`${name} expects ${sig.params.length} argument(s), got ${args.length}`);
      args.forEach(a => this.checkExpr(a, scope, ctx));
      return this.asyncResult(sig, sig.ret);
    }
    const subst: Substitution = new Map();
    args.forEach((arg, i) => {
      // Closures infer their param/return types from a fn-typed parameter.
      const argType = arg.kind === 'closure'
        ? this.checkClosure(arg, scope, ctx, sig.params[i])
        : this.checkExpr(arg, scope, ctx);
      if (!unify(sig.params[i], argType, subst)) {
        this.error(`${name} argument ${i + 1}: expected ${typeToString(substitute(sig.params[i], subst))}, got ${typeToString(argType)}`);
      }
    });
    return this.asyncResult(sig, substitute(sig.ret, subst));
  }

  // Result type of calling a function. An async fn whose annotation already
  // says Promise<T> is left alone; an implicitly-async fn (uses .await but is
  // annotated : T) has its result wrapped so callers must .await it.
  private asyncResult(sig: FnSig, ret: Type): Type {
    if (sig.isAsync && ret.kind !== 'promise') return { kind: 'promise', inner: ret };
    return ret;
  }

  private checkMember(object: Expr, property: string, scope: Scope, ctx: FnContext): Type {
    const objType = this.checkExpr(object, scope, ctx);

    if (objType.kind === 'struct') {
      const struct = this.structs.get(objType.name)!;
      const field = struct.fields.find(f => f.name === property);
      if (field) {
        // Visibility: enforced across modules once multi-file lands; within
        // a single module all fields are accessible
        return this.toType(field.type, struct.typeParams ?? []);
      }
      const method = this.findMethod(objType.name, property);
      if (method) return { kind: 'fn', params: method.params, ret: method.ret, isAsync: method.isAsync };
      this.error(`${objType.name} has no field '${property}'`);
      return UNKNOWN;
    }

    if ((objType.kind === 'array' || objType.kind === 'str') && property === 'length') return NUM;
    if (objType.kind === 'unknown') return UNKNOWN;
    if (objType.kind === 'enum') {
      this.error(`Cannot access '.${property}' on ${typeToString(objType)} — use match or a postfix operator`);
      return UNKNOWN;
    }

    this.error(`Type ${typeToString(objType)} has no member '${property}'`);
    return UNKNOWN;
  }

  private checkPostfix(expr: Extract<Expr, { kind: 'postfix' }>, scope: Scope, ctx: FnContext): Type {
    const inner = this.checkExpr(expr.expr, scope, ctx);
    switch (expr.op) {
      case '.await':
        ctx.sawAwait = true;
        if (inner.kind === 'promise') return inner.inner;
        if (inner.kind === 'unknown') return UNKNOWN;
        this.error(`.await requires a Promise, got ${typeToString(inner)}`);
        return UNKNOWN;

      case '.try': {
        if (inner.kind === 'unknown') return UNKNOWN;
        if (inner.kind !== 'enum' || inner.name !== 'Result') {
          this.error(`.try requires a Result, got ${typeToString(inner)}`);
          return UNKNOWN;
        }
        if (ctx.ret.kind !== 'enum' || ctx.ret.name !== 'Result') {
          if (ctx.ret.kind !== 'unknown') {
            this.error(`.try can only be used in a function returning Result (${ctx.name} returns ${typeToString(ctx.ret)})`);
          }
        }
        return inner.typeArgs[0];
      }

      case '?': {
        if (inner.kind === 'unknown') return UNKNOWN;
        if (inner.kind !== 'enum' || inner.name !== 'Option') {
          this.error(`'?' requires an Option, got ${typeToString(inner)}`);
          return UNKNOWN;
        }
        if (ctx.ret.kind !== 'enum' || ctx.ret.name !== 'Option') {
          if (ctx.ret.kind !== 'unknown') {
            this.error(`'?' can only be used in a function returning Option (${ctx.name} returns ${typeToString(ctx.ret)})`);
          }
        }
        return inner.typeArgs[0];
      }

      case '.unwrap': {
        if (inner.kind === 'enum' && (inner.name === 'Option' || inner.name === 'Result')) {
          return inner.typeArgs[0];
        }
        if (inner.kind === 'unknown') return UNKNOWN;
        this.error(`.unwrap requires Option or Result, got ${typeToString(inner)}`);
        return UNKNOWN;
      }

      case '.unwrap_or': {
        const fallback = expr.arg ? this.checkExpr(expr.arg, scope, ctx) : UNKNOWN;
        if (inner.kind === 'enum' && (inner.name === 'Option' || inner.name === 'Result')) {
          const valueType = inner.typeArgs[0];
          if (!typesCompatible(valueType, fallback)) {
            this.error(`.unwrap_or fallback is ${typeToString(fallback)}, expected ${typeToString(valueType)}`);
          }
          return valueType;
        }
        if (inner.kind === 'unknown') return fallback;
        this.error(`.unwrap_or requires Option or Result, got ${typeToString(inner)}`);
        return UNKNOWN;
      }

      case '.catch': {
        if (inner.kind === 'enum' && inner.name === 'Result') return inner;
        if (inner.kind === 'unknown') return UNKNOWN;
        this.error(`.catch requires a Result, got ${typeToString(inner)}`);
        return UNKNOWN;
      }
    }
  }

  private checkMatch(expr: MatchExpr, scope: Scope, ctx: FnContext): Type {
    const scrutineeType = this.checkExpr(expr.expr, scope, ctx);
    let resultType: Type | undefined;

    for (const arm of expr.arms) {
      const armScope = new Scope(scope);
      this.checkPattern(arm.pattern, scrutineeType, armScope);
      if (arm.guard) {
        const guardType = this.checkExpr(arm.guard, armScope, ctx);
        if (!typesCompatible(BOOL, guardType)) {
          this.error(`Match guard must be bool, got ${typeToString(guardType)}`);
        }
      }
      const armType = this.checkBlockValue(arm.body, armScope, ctx);
      if (resultType === undefined || resultType.kind === 'unknown' || resultType.kind === 'void') {
        resultType = armType;
      } else if (armType.kind !== 'unknown' && armType.kind !== 'void' && !typesCompatible(resultType, armType)) {
        this.error(`Match arms disagree: ${typeToString(resultType)} vs ${typeToString(armType)}`);
      }
    }

    this.checkExhaustiveness(expr, scrutineeType);
    return resultType ?? VOID;
  }

  private patternCoversAll(p: Pattern): boolean {
    return p.kind === 'wildcard' || p.kind === 'identifier';
  }

  private checkExhaustiveness(expr: MatchExpr, scrutinee: Type): void {
    if (scrutinee.kind === 'unknown') return;
    // Guarded arms never count toward coverage
    const unguarded = expr.arms.filter(a => !a.guard).map(a => a.pattern);
    if (unguarded.some(p => this.patternCoversAll(p))) return;

    if (scrutinee.kind === 'enum') {
      const decl = this.enums.get(scrutinee.name);
      if (!decl) return;
      const covered = new Set(
        unguarded.filter(p => p.kind === 'enum_variant').map(p => (p as { name: string }).name),
      );
      const missing = decl.variants.filter(v => !covered.has(v.name)).map(v => v.name);
      if (missing.length) {
        this.error(`Match on ${scrutinee.name} is not exhaustive — missing: ${missing.join(', ')}`);
      }
      return;
    }

    if (scrutinee.kind === 'bool') {
      const literals = new Set(
        unguarded.filter(p => p.kind === 'literal').map(p => String((p as { value: unknown }).value)),
      );
      if (!literals.has('true') || !literals.has('false')) {
        this.error('Match on bool must cover both true and false, or use a wildcard arm');
      }
      return;
    }

    if (scrutinee.kind === 'tuple' && scrutinee.elements.every(e => e.kind === 'enum')) {
      const variantSets = scrutinee.elements.map(e =>
        (this.enums.get((e as { name: string }).name)?.variants ?? []).map(v => v.name),
      );
      const total = variantSets.reduce((n, s) => n * s.length, 1);
      if (total === 0) return;
      if (total > 64) {
        this.error('Tuple match has too many variant combinations to verify — add a wildcard arm');
        return;
      }
      const combos = variantSets.reduce<string[][]>(
        (acc, set) => acc.flatMap(c => set.map(v => [...c, v])),
        [[]],
      );
      const tuplePatterns = unguarded.filter(p => p.kind === 'tuple');
      const elementCovers = (p: Pattern, variant: string): boolean =>
        this.patternCoversAll(p) || (p.kind === 'enum_variant' && p.name === variant);
      const missing = combos.filter(combo =>
        !tuplePatterns.some(tp =>
          tp.elements.length === combo.length && combo.every((v, i) => elementCovers(tp.elements[i], v)),
        ),
      );
      if (missing.length) {
        this.error(`Tuple match is not exhaustive — e.g. (${missing[0].join(', ')}) is unhandled`);
      }
      return;
    }

    this.error(`Match on ${typeToString(scrutinee)} needs a wildcard or binding arm`);
  }

  private checkPattern(pattern: Pattern, scrutinee: Type, scope: Scope): void {
    switch (pattern.kind) {
      case 'wildcard':
        return;

      case 'literal': {
        const litType: Type = typeof pattern.value === 'number' ? NUM
          : typeof pattern.value === 'string' ? STR : BOOL;
        if (!typesCompatible(litType, scrutinee)) {
          this.error(`Pattern ${JSON.stringify(pattern.value)} does not match ${typeToString(scrutinee)}`);
        }
        return;
      }

      case 'identifier': {
        // A bare name matching a variant of the scrutinee enum is a variant
        // pattern (None, Empty), not a binding. Reclassify in place so
        // exhaustiveness and codegen see it correctly.
        if (scrutinee.kind === 'enum') {
          const variant = this.enums.get(scrutinee.name)?.variants.find(v => v.name === pattern.name);
          if (variant) {
            if ((variant.fields?.length ?? 0) > 0) {
              this.error(`Variant ${pattern.name} has fields — match it with ${pattern.name}(...)`);
            }
            const reclassified = pattern as unknown as { kind: string; name: string; args: string[] };
            reclassified.kind = 'enum_variant';
            reclassified.args = [];
            return;
          }
        }
        scope.declare(pattern.name, { type: scrutinee, mutable: false });
        return;
      }

      case 'enum_variant': {
        if (scrutinee.kind === 'unknown') {
          pattern.args.forEach(a => { if (a !== '_') scope.declare(a, { type: UNKNOWN, mutable: false }); });
          return;
        }
        if (scrutinee.kind !== 'enum') {
          this.error(`Pattern '${pattern.name}(...)' does not match ${typeToString(scrutinee)}`);
          return;
        }
        const enumDecl = this.enums.get(scrutinee.name);
        const variant = enumDecl?.variants.find(v => v.name === pattern.name);
        if (!enumDecl || !variant) {
          this.error(`${scrutinee.name} has no variant '${pattern.name}'`);
          return;
        }
        const declParams = enumDecl.typeParams ?? [];
        const subst: Substitution = new Map(declParams.map((p, i) => [p, scrutinee.typeArgs[i] ?? UNKNOWN]));
        const fieldTypes = (variant.fields ?? []).map(f => substitute(this.toType(f, declParams), subst));
        if (pattern.args.length !== fieldTypes.length) {
          this.error(`Variant ${pattern.name} has ${fieldTypes.length} field(s), pattern binds ${pattern.args.length}`);
        }
        pattern.args.forEach((arg, i) => {
          if (arg !== '_') scope.declare(arg, { type: fieldTypes[i] ?? UNKNOWN, mutable: false });
        });
        return;
      }

      case 'struct_pattern': {
        if (scrutinee.kind !== 'struct' || scrutinee.name !== pattern.name) {
          if (scrutinee.kind !== 'unknown') {
            this.error(`Pattern '${pattern.name} { ... }' does not match ${typeToString(scrutinee)}`);
          }
        }
        const struct = this.structs.get(pattern.name);
        for (const field of pattern.fields) {
          const declared = struct?.fields.find(f => f.name === field.name);
          const fieldType = declared ? this.toType(declared.type, struct?.typeParams ?? []) : UNKNOWN;
          if (struct && !declared) this.error(`${pattern.name} has no field '${field.name}'`);
          scope.declare(field.bind, { type: fieldType, mutable: false });
        }
        return;
      }

      case 'tuple': {
        if (scrutinee.kind === 'tuple') {
          if (scrutinee.elements.length !== pattern.elements.length) {
            this.error(`Tuple pattern has ${pattern.elements.length} element(s), value has ${scrutinee.elements.length}`);
          }
          pattern.elements.forEach((el, i) => {
            this.checkPattern(el, scrutinee.elements[i] ?? UNKNOWN, scope);
          });
        } else if (scrutinee.kind === 'unknown') {
          pattern.elements.forEach(el => this.checkPattern(el, UNKNOWN, scope));
        } else {
          this.error(`Tuple pattern does not match ${typeToString(scrutinee)}`);
        }
        return;
      }
    }
  }

  // ---- helpers ----

  private findMethod(structName: string, methodName: string): FnSig | undefined {
    const struct = this.structs.get(structName);
    const method = struct?.methods.find(m => m.name === methodName);
    if (!struct || !method) return undefined;
    const typeParams = [...(struct.typeParams ?? []), ...(method.typeParams ?? [])];
    return {
      typeParams,
      params: method.params.map(p => this.toType(p.type, typeParams)),
      ret: this.toType(method.returnType, typeParams),
      isAsync: method.isAsync === true,
      isComptime: method.isComptime,
      decl: method,
    };
  }

  private variantValueType(ctor: VariantInfo, subst?: Substitution): Type {
    const enumDecl = this.enums.get(ctor.enumName)!;
    const params = enumDecl.typeParams ?? [];
    const typeArgs = params.map(p => (subst?.get(p)) ?? UNKNOWN);
    return { kind: 'enum', name: ctor.enumName, typeArgs };
  }

  private error(message: string): void {
    const loc = this.currentNode ? this.locs?.get(this.currentNode) : undefined;
    this.diagnostics.push({
      message, context: this.context, severity: 'error',
      line: loc?.line, column: loc?.column,
    });
  }
}

export function check(program: Program, options: CheckOptions = {}): void {
  new Checker().check(program, options);
}
