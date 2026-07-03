// Code Generator for NovaScript -> JavaScript

import type {
  Program, Expr, Stmt, FunctionDecl, StructDecl, EnumDecl,
  Pattern, MatchArm, Block, LetStmt, ImportStmt,
  PostfixExpr, ReturnStmt as ReturnStmtType, IfStmt as IfStmtType, WhileStmt as WhileStmtType,
  ForStmt as ForStmtType
} from './ast.js';
import { MATH_BUILTINS } from './builtins.js';

export interface GenerateOptions {
  /** Emit ESM export/import (multi-file build). Off for single-file scripts. */
  module?: boolean;
  /** The entry module auto-invokes main(); library modules do not. */
  entry?: boolean;
  /**
   * Imported struct declarations. Not emitted, but their field order lets a
   * typed literal like `Vec2 { x, y }` compile to the imported `Vec2(x, y)`
   * constructor call (preserving methods) rather than a bare object.
   */
  externalStructs?: StructDecl[];
}

export class CodeGenerator {
  private indent = 0;
  private output: string[] = [];
  private structs = new Map<string, StructDecl>();
  private moduleMode = false;
  private matchCounter = 0;

  generate(program: Program, options: GenerateOptions = {}): string {
    this.output = [];
    this.indent = 0;
    this.moduleMode = options.module === true;
    for (const struct of options.externalStructs ?? []) this.structs.set(struct.name, struct);
    for (const decl of program.declarations) {
      if (decl.kind === 'struct') this.structs.set(decl.name, decl);
    }

    // ESM imports belong at the top of the module
    if (this.moduleMode) {
      for (const stmt of program.statements) {
        if (stmt.kind === 'import') this.generateImport(stmt);
      }
      if (program.statements.some(s => s.kind === 'import')) this.line();
    }

    this.emitUsedPreludeConstructors(program);

    // Generate declarations first (comptime fns were fully evaluated away)
    for (const decl of program.declarations) {
      if (decl.kind === 'function') {
        if (decl.isComptime) continue;
        this.generateFunction(decl);
      } else if (decl.kind === 'struct') {
        this.generateStruct(decl);
      } else if (decl.kind === 'enum') {
        this.generateEnum(decl);
      }
    }

    // Then statements (imports already emitted at top in module mode)
    for (const stmt of program.statements) {
      if (stmt.kind === 'import') {
        if (!this.moduleMode) this.generateImport(stmt);
      } else {
        this.generateStmt(stmt);
      }
    }

    // Entry point: a declared main() runs automatically unless already invoked.
    // In a multi-file build only the entry module does this.
    const runsEntry = !this.moduleMode || options.entry === true;
    const hasMain = program.declarations.some(d => d.kind === 'function' && d.name === 'main');
    const callsMain = program.statements.some(s =>
      s.kind === 'expr' && s.expr.kind === 'call' &&
      s.expr.callee.kind === 'identifier' && s.expr.callee.name === 'main');
    if (runsEntry && hasMain && !callsMain) {
      this.line('main();');
    }

    return this.output.join('\n');
  }

  // `export ` prefix for pub declarations in module mode
  private exportPrefix(isPub: boolean): string {
    return this.moduleMode && isPub ? 'export ' : '';
  }

  private line(text = ''): void {
    this.output.push('  '.repeat(this.indent) + text);
  }

  // Option/Result live in the checker only; emit just the constructors the
  // program references so output stays runtime-free and readable
  private emitUsedPreludeConstructors(program: Program): void {
    const declaredEnums = new Set(
      program.declarations.filter(d => d.kind === 'enum').map(d => d.name),
    );
    if (declaredEnums.has('Option') && declaredEnums.has('Result')) return;

    const used = new Set<string>();
    const note = (name: string) => {
      if (name === 'Some' || name === 'None' || name === 'Ok' || name === 'Err') used.add(name);
    };
    const visitExpr = (e: Expr): void => {
      switch (e.kind) {
        case 'identifier': note(e.name); break;
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
        case 'postfix': visitExpr(e.expr); if (e.arg) visitExpr(e.arg); break;
        case 'match':
          visitExpr(e.expr);
          e.arms.forEach(a => { if (a.guard) visitExpr(a.guard); visitBlock(a.body); });
          break;
        case 'literal': break;
      }
    };
    const visitStmt = (s: Stmt | ImportStmt): void => {
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
        default: break;
      }
    };
    const visitBlock = (b: Block): void => b.statements.forEach(visitStmt);

    for (const decl of program.declarations) {
      if (decl.kind === 'function') visitBlock(decl.body);
      else if (decl.kind === 'struct') decl.methods.forEach(m => visitBlock(m.body));
    }
    program.statements.forEach(visitStmt);

    if (used.size === 0) return;
    this.line('// Prelude');
    if (used.has('Some')) this.line('function Some(value) { return { tag: "Some", value }; }');
    if (used.has('None')) this.line('const None = { tag: "None" };');
    if (used.has('Ok')) this.line('function Ok(value) { return { tag: "Ok", value }; }');
    if (used.has('Err')) this.line('function Err(value) { return { tag: "Err", value }; }');
    this.line();
  }

  private generateFunction(fn: FunctionDecl): void {
    const params = fn.params.map(p => p.name).join(', ');
    const keyword = `${this.exportPrefix(fn.isPub)}${fn.isAsync ? 'async function' : 'function'}`;

    if (fn.body.statements.length === 0 && fn.returnType) {
      this.line(`${keyword} ${fn.name}(${params}) {`);
      this.indent++;
      this.line('return undefined;');
      this.indent--;
      this.line('}');
      return;
    }

    this.line(`${keyword} ${fn.name}(${params}) {`);
    this.indent++;
    if (fn.returnType && fn.returnType.kind !== 'void') {
      this.generateBlockReturningLast(fn.body);
    } else {
      this.generateBlock(fn.body);
    }
    this.indent--;
    this.line('}');
    this.line();
  }

  private generateStruct(struct: StructDecl): void {
    const fields = struct.fields.map(f => f.name).join(', ');

    this.line(`// ${struct.name} struct`);
    this.line(`${this.exportPrefix(struct.isPub)}function ${struct.name}(${fields}) {`);
    this.indent++;
    if (struct.methods.length === 0) {
      this.line(`return { ${fields} };`);
    } else {
      this.line('return {');
      this.indent++;
      if (fields) this.line(`${fields},`);
      struct.methods.forEach((method, i) => {
        const params = method.params.map(p => p.name).join(', ');
        const isLast = i === struct.methods.length - 1;
        this.line(`${method.isAsync ? 'async ' : ''}${method.name}(${params}) {`);
        this.indent++;
        if (method.returnType && method.returnType.kind !== 'void') {
          this.generateBlockReturningLast(method.body);
        } else {
          this.generateBlock(method.body);
        }
        this.indent--;
        this.line(`}${isLast ? '' : ','}`);
      });
      this.indent--;
      this.line('};');
    }
    this.indent--;
    this.line('}');
    this.line();
  }

  private generateEnum(enumDecl: EnumDecl): void {
    this.line(`// ${enumDecl.name} enum`);
    
    const ex = this.exportPrefix(enumDecl.isPub);
    for (const variant of enumDecl.variants) {
      const variantName = `${enumDecl.name}_${variant.name}`;
      const fieldCount = variant.fields?.length ?? 0;

      if (fieldCount === 0) {
        this.line(`${ex}const ${variantName} = { tag: "${variant.name}" };`);
      } else {
        const params = variant.fields!.map((_, i) => `value${i}`).join(', ');

        if (fieldCount === 1) {
          this.line(`${ex}function ${variantName}(value) { return { tag: "${variant.name}", value }; }`);
        } else {
          this.line(`${ex}function ${variantName}(${params}) { return { tag: "${variant.name}", values: [${params}] }; }`);
        }
      }
    }
    this.line();
  }

  private generateImport(imp: ImportStmt): void {
    const names = imp.names.join(', ');
    const from = this.moduleMode ? this.esmPath(imp.from) : imp.from;
    this.line(`import { ${names} } from "${from}";`);
    // Safe imports are re-exported so a name can travel through a barrel module
    if (this.moduleMode && !imp.isUnsafe) {
      this.line(`export { ${names} } from "${from}";`);
    }
  }

  // Relative NovaScript imports compile to .js specifiers; bare/package
  // specifiers pass through unchanged
  private esmPath(from: string): string {
    if (!from.startsWith('.')) return from;
    return from.replace(/\.nova$/, '') + '.js';
  }

  private generateStmt(stmt: Stmt | ImportStmt): void {
    switch (stmt.kind) {
      case 'let':
        this.generateLet(stmt);
        break;
      case 'return':
        this.generateReturn(stmt);
        break;
      case 'if':
        this.generateIf(stmt);
        break;
      case 'while':
        this.generateWhile(stmt);
        break;
      case 'for':
        this.generateFor(stmt);
        break;
      case 'block':
        this.generateBlock(stmt);
        break;
      case 'expr':
        if (stmt.expr.kind === 'match' && stmt.expr.stmtPosition) {
          this.generateMatchStatement(stmt.expr);
        } else {
          this.line(`${this.generateExpr(stmt.expr)};`);
        }
        break;
      case 'unsafe':
        const lines = stmt.body.split('\n');
        for (const line of lines) {
          this.line(line.trim());
        }
        break;
      case 'import':
        this.generateImport(stmt);
        break;
    }
  }

  private generateLet(letStmt: LetStmt): void {
    const keyword = letStmt.mutable ? 'let' : 'const';
    const name = letStmt.name;
    const init = this.generateExpr(letStmt.init);
    this.line(`${keyword} ${name} = ${init};`);
  }

  private generateReturn(ret: ReturnStmtType): void {
    if (ret.value) {
      this.line(`return ${this.generateExpr(ret.value)};`);
    } else {
      this.line('return;');
    }
  }

  private generateIf(ifStmt: IfStmtType, tail = false): void {
    let current: IfStmtType | Block | undefined = ifStmt;
    let first = true;
    while (current) {
      if (current.kind === 'if') {
        const keyword = first ? 'if' : '} else if';
        this.line(`${keyword} (${this.generateExpr(current.cond)}) {`);
        this.indent++;
        if (tail) this.generateBlockReturningLast(current.thenBranch);
        else this.generateBlock(current.thenBranch);
        this.indent--;
        current = current.elseBranch;
        first = false;
      } else {
        this.line('} else {');
        this.indent++;
        if (tail) this.generateBlockReturningLast(current);
        else this.generateBlock(current);
        this.indent--;
        current = undefined;
      }
    }
    this.line('}');
  }

  private generateWhile(whileStmt: WhileStmtType): void {
    this.line(`while (${this.generateExpr(whileStmt.cond)}) {`);
    this.indent++;
    this.generateBlock(whileStmt.body);
    this.indent--;
    this.line('}');
  }

  private generateFor(forStmt: ForStmtType): void {
    // Ranges lower to a classic counting loop; everything else uses for-of
    if (forStmt.iterable.kind === 'range') {
      const v = forStmt.varName;
      const start = this.generateExpr(forStmt.iterable.start);
      const end = this.generateExpr(forStmt.iterable.end);
      this.line(`for (let ${v} = ${start}; ${v} < ${end}; ${v}++) {`);
    } else {
      this.line(`for (const ${forStmt.varName} of ${this.generateExpr(forStmt.iterable)}) {`);
    }
    this.indent++;
    this.generateBlock(forStmt.body);
    this.indent--;
    this.line('}');
  }

  private generateBlock(block: Block): void {
    for (const stmt of block.statements) {
      this.generateStmt(stmt);
    }
  }

  private generateExpr(expr: Expr): string {
    switch (expr.kind) {
      case 'literal':
        if (typeof expr.value === 'string') {
          return JSON.stringify(expr.value);
        }
        return String(expr.value);

      case 'identifier':
        return expr.name === 'self' ? 'this' : expr.name;

      case 'binary': {
        const left = this.generateExpr(expr.left);
        const right = this.generateExpr(expr.right);
        // Operator overloading resolved by the checker: a + b → a.plus(b)
        if (expr.overloadMethod) return `${left}.${expr.overloadMethod}(${right})`;
        return `(${left} ${expr.op} ${right})`;
      }

      case 'unary':
        const operand = this.generateExpr(expr.operand);
        return `(${expr.op}${operand})`;

      case 'call': {
        // UFCS resolved by the checker: v.normalize() → normalize(v)
        if (expr.ufcs && expr.callee.kind === 'member') {
          const receiver = this.generateExpr(expr.callee.object);
          const rest = expr.args.map(a => this.generateExpr(a));
          return `${expr.callee.property}(${[receiver, ...rest].join(', ')})`;
        }
        const args = expr.args.map(a => this.generateExpr(a)).join(', ');
        // Built-in math free functions compile to Math.* host calls
        if (expr.callee.kind === 'identifier' && MATH_BUILTINS[expr.callee.name]) {
          return `${MATH_BUILTINS[expr.callee.name].js}(${args})`;
        }
        const callee = this.generateExpr(expr.callee);
        return `${callee}(${args})`;
      }

      case 'member':
        const obj = this.generateExpr(expr.object);
        return `${obj}.${expr.property}`;

      case 'postfix':
        return this.generatePostfix(expr);

      case 'object': {
        // A typed literal `Vec2 { x: 1 }` calls the struct constructor so
        // instances carry their methods
        if (expr.typeName && this.structs.has(expr.typeName)) {
          const struct = this.structs.get(expr.typeName)!;
          const byName = new Map(expr.fields.map(f => [f.name, f.value]));
          const args = struct.fields
            .map(f => byName.has(f.name) ? this.generateExpr(byName.get(f.name)!) : 'undefined')
            .join(', ');
          return `${expr.typeName}(${args})`;
        }
        const fields = expr.fields.map(f => `${f.name}: ${this.generateExpr(f.value)}`).join(', ');
        return `{ ${fields} }`;
      }

      case 'array':
        const elements = expr.elements.map(e => this.generateExpr(e)).join(', ');
        return `[${elements}]`;

      case 'index':
        return `${this.generateExpr(expr.object)}[${this.generateExpr(expr.index)}]`;

      case 'tuple_expr':
        return `[${expr.elements.map(e => this.generateExpr(e)).join(', ')}]`;

      case 'range': {
        const start = this.generateExpr(expr.start);
        const end = this.generateExpr(expr.end);
        return `Array.from({ length: ${end} - ${start} }, (_, __i) => ${start} + __i)`;
      }

      case 'template': {
        const body = expr.parts.map(part => {
          if (part.kind === 'expr') return '${' + this.generateExpr(part.expr) + '}';
          return part.value
            .replace(/\\/g, '\\\\')
            .replace(/`/g, '\\`')
            .replace(/\$\{/g, '\\${');
        }).join('');
        return '`' + body + '`';
      }

      case 'unsafe_expr': {
        const body = expr.body;
        // A single expression can be inlined; statements need an IIFE and
        // must produce their value with an explicit return
        if (!body.includes(';') && !body.includes('\n')) return `(${body})`;
        return `(() => { ${body} })()`;
      }

      case 'match':
        return this.generateMatch(expr);
    }
  }

  private generatePostfix(postfix: PostfixExpr): string {
    const expr = this.generateExpr(postfix.expr);

    switch (postfix.op) {
      case '.await':
        return `(await ${expr})`;

      case '.try':
        return `((${expr}_val => { if (${expr}_val.tag === "Err") return ${expr}_val; return ${expr}_val.value; })(${expr}))`;

      case '.catch':
        return `((${expr}_val => { if (${expr}_val.tag === "Ok") return ${expr}_val; return { tag: "Ok", value: ${expr}_val.value }; })(${expr}))`;

      case '.unwrap':
        return `${expr}.value`;

      case '.unwrap_or':
        const arg = postfix.arg ? this.generateExpr(postfix.arg) : 'undefined';
        return `(${expr}.tag === "None" || ${expr}.tag === "Err" ? ${arg} : ${expr}.value)`;

      case '?':
        return `((${expr}_opt => { if (${expr}_opt.tag === "None") return { tag: "None" }; return ${expr}_opt.value; })(${expr}))`;
    }
  }

  private generateMatch(matchExpr: import('./ast.js').MatchExpr): string {
    // Sequential if-blocks with early return: a matched arm returns from the
    // IIFE, a failed guard falls through to the next arm's check.
    const tempVar = `__match_val`;
    const gen = new CodeGenerator();
    gen.structs = this.structs;
    gen.indent = 1;
    gen.line(`const ${tempVar} = ${this.generateExpr(matchExpr.expr)};`);

    for (const arm of matchExpr.arms) {
      const condition = this.generatePatternCondition(tempVar, arm.pattern);
      const isCatchAll = condition === 'true' && !arm.guard;
      if (!isCatchAll) {
        gen.line(`if (${condition}) {`);
        gen.indent++;
      }
      for (const binding of this.generatePatternBindings(tempVar, arm.pattern)) {
        gen.line(binding);
      }
      if (arm.guard) {
        gen.line(`if (${gen.generateExpr(arm.guard)}) {`);
        gen.indent++;
      }
      gen.generateBlockReturningLast(arm.body);
      // A matched arm must not fall through to later arms
      const last = arm.body.statements[arm.body.statements.length - 1];
      if (!last || (last.kind !== 'expr' && last.kind !== 'return')) {
        gen.line('return;');
      }
      if (arm.guard) {
        gen.indent--;
        gen.line('}');
      }
      if (!isCatchAll) {
        gen.indent--;
        gen.line('}');
      }
      if (isCatchAll) break;
    }

    return `(() => {\n${gen.output.join('\n')}\n})()`;
  }

  // Statement-position match: a plain labelled if-chain instead of an IIFE, so
  // `return` and lowered `.try`/`?` early-returns inside arms escape to the
  // enclosing function. A matched arm breaks out of the label.
  private generateMatchStatement(matchExpr: import('./ast.js').MatchExpr): void {
    const n = ++this.matchCounter;
    const tempVar = `__match${n}`;
    const label = `__matched${n}`;
    this.line(`const ${tempVar} = ${this.generateExpr(matchExpr.expr)};`);
    this.line(`${label}: {`);
    this.indent++;
    for (const arm of matchExpr.arms) {
      const condition = this.generatePatternCondition(tempVar, arm.pattern);
      const bindings = this.generatePatternBindings(tempVar, arm.pattern);
      const isCatchAll = condition === 'true' && !arm.guard;
      if (!isCatchAll) {
        this.line(`if (${condition}) {`);
        this.indent++;
      }
      for (const b of bindings) this.line(b);
      if (arm.guard) {
        this.line(`if (${this.generateExpr(arm.guard)}) {`);
        this.indent++;
      }
      this.generateBlock(arm.body);
      this.line(`break ${label};`);
      if (arm.guard) { this.indent--; this.line('}'); }
      if (!isCatchAll) { this.indent--; this.line('}'); }
      if (isCatchAll) break;
    }
    this.indent--;
    this.line('}');
  }

  private generatePatternCondition(path: string, pattern: Pattern): string {
    switch (pattern.kind) {
      case 'wildcard':
        return 'true';

      case 'literal':
        const litVal = typeof pattern.value === 'string'
          ? JSON.stringify(pattern.value)
          : String(pattern.value);
        return `${path} === ${litVal}`;

      case 'identifier':
        return 'true';

      case 'enum_variant':
        return `${path}.tag === "${pattern.name}"`;

      case 'struct_pattern':
        return 'true';

      case 'tuple': {
        const conditions = pattern.elements
          .map((el, i) => this.generatePatternCondition(`${path}[${i}]`, el))
          .filter(c => c !== 'true');
        return conditions.join(' && ') || 'true';
      }
    }
  }

  private generatePatternBindings(path: string, pattern: Pattern): string[] {
    switch (pattern.kind) {
      case 'identifier':
        return [`const ${pattern.name} = ${path};`];

      case 'enum_variant':
        if (pattern.args.length === 1) {
          return pattern.args[0] === '_' ? [] : [`const ${pattern.args[0]} = ${path}.value;`];
        }
        return pattern.args
          .map((arg, i) => arg === '_' ? '' : `const ${arg} = ${path}.values[${i}];`)
          .filter(Boolean);

      case 'struct_pattern':
        return pattern.fields.map(f => `const ${f.bind} = ${path}.${f.name};`);

      case 'tuple':
        return pattern.elements.flatMap((el, i) => this.generatePatternBindings(`${path}[${i}]`, el));

      default:
        return [];
    }
  }

  // Emits a block where the last statement's value becomes `return <expr>;`.
  // Tail if/else chains recurse so each branch returns its final expression.
  private generateBlockReturningLast(block: Block): void {
    block.statements.forEach((stmt, i) => {
      if (i === block.statements.length - 1) {
        this.generateStmtReturningLast(stmt);
      } else {
        this.generateStmt(stmt);
      }
    });
  }

  private generateStmtReturningLast(stmt: Stmt): void {
    if (stmt.kind === 'expr') {
      this.line(`return ${this.generateExpr(stmt.expr)};`);
    } else if (stmt.kind === 'if') {
      this.generateIf(stmt, true);
    } else {
      this.generateStmt(stmt);
    }
  }
}

export function generate(program: Program, options: GenerateOptions = {}): string {
  const generator = new CodeGenerator();
  return generator.generate(program, options);
}
