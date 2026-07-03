// Minimal opinionated formatter for NovaScript.
//
// Parses source to an AST and pretty-prints it back with canonical spacing and
// 4-space indentation. Line comments are preserved by interleaving them with
// the nodes they sit above/beside, using the source positions the parser
// records. Comments inside struct/enum bodies are the one thing that may move,
// since those inner members carry no position — everything else round-trips.

import { tokenize, Comment } from './lexer.js';
import { parse } from './parser.js';
import type {
  Program, Expr, Stmt, Block, TypeAnnotation, Pattern,
  FunctionDecl, StructDecl, EnumDecl, MatchExpr, TemplatePart, SourceLoc,
} from './ast.js';

const INDENT = '    '; // 4 spaces

// Binary operator precedence (higher binds tighter). Assignment is lowest.
const PREC: Record<string, number> = {
  '=': 0,
  '||': 1,
  '&&': 2,
  '==': 3, '!=': 3,
  '<': 4, '>': 4, '<=': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
};

type TopItem = FunctionDecl | StructDecl | EnumDecl | Stmt | { kind: 'import' } & any;

export function format(source: string): string {
  const comments: Comment[] = [];
  tokenize(source, c => comments.push(c));
  const program = parse(source);
  return new Formatter(program, comments).run();
}

class Formatter {
  private out: string[] = [];
  private depth = 0;
  private locs: WeakMap<object, SourceLoc>;
  private ci = 0; // next unconsumed comment

  constructor(private program: Program, private comments: Comment[]) {
    this.locs = program.locs ?? new WeakMap();
  }

  run(): string {
    // Recover original top-level order (decls and statements live in separate
    // arrays) by sorting on recorded line numbers.
    const items: object[] = [...this.program.declarations, ...this.program.statements];
    items.sort((a, b) => this.lineOf(a) - this.lineOf(b));

    items.forEach((item, i) => {
      // One blank line between top-level items (before any hugging comment), but
      // keep consecutive imports grouped together.
      const prev = items[i - 1] as any;
      const bothImports = prev && (prev.kind === 'import') && ((item as any).kind === 'import');
      if (i > 0 && !bothImports) this.out.push('');
      this.flushStandaloneBefore(this.lineOf(item));
      this.emitTop(item);
    });
    this.flushRemaining();

    return this.out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
  }

  // ── comment interleaving ──────────────────────────────────────────────

  private lineOf(node: object): number {
    return this.locs.get(node)?.line ?? Number.MAX_SAFE_INTEGER;
  }

  private flushStandaloneBefore(line: number): void {
    while (this.ci < this.comments.length &&
           !this.comments[this.ci].trailing &&
           this.comments[this.ci].line < line) {
      this.line(commentText(this.comments[this.ci]));
      this.ci++;
    }
  }

  private trailingFor(line: number): string {
    if (this.ci < this.comments.length &&
        this.comments[this.ci].trailing &&
        this.comments[this.ci].line === line) {
      const c = this.comments[this.ci++];
      return `  ${commentText(c)}`;
    }
    return '';
  }

  private flushRemaining(): void {
    while (this.ci < this.comments.length) {
      const c = this.comments[this.ci++];
      if (!c.trailing) this.line(commentText(c));
    }
  }

  // ── emit helpers ──────────────────────────────────────────────────────

  private line(text: string): void {
    this.out.push(text === '' ? '' : INDENT.repeat(this.depth) + text);
  }

  private emitTop(item: any): void {
    switch (item.kind) {
      case 'function': return this.emitFunction(item);
      case 'struct': return this.emitStruct(item);
      case 'enum': return this.emitEnum(item);
      case 'import': return this.emitImport(item);
      default: return this.emitStmt(item);
    }
  }

  // ── declarations ──────────────────────────────────────────────────────

  private emitFunction(fn: FunctionDecl): void {
    const mods =
      (fn.isPub ? 'pub ' : '') +
      (fn.isAsync ? 'async ' : '') +
      (fn.isComptime ? 'comptime ' : '');
    const tp = fn.typeParams?.length ? `<${fn.typeParams.join(', ')}>` : '';
    const params = fn.params.map(p => p.name + (p.type ? `: ${formatType(p.type)}` : '')).join(', ');
    const ret = fn.returnType ? `: ${formatType(fn.returnType)}` : '';
    this.line(`${mods}fn ${fn.name}${tp}(${params})${ret} {`);
    this.emitBlockBody(fn.body);
    this.line('}');
  }

  // Struct methods have no `fn` keyword, and `self` (if present) is implicit
  // rather than stored in params.
  private emitMethod(fn: FunctionDecl): void {
    const mods = (fn.isPub ? 'pub ' : '') + (fn.isAsync ? 'async ' : '');
    const rest = fn.params.map(p => p.name + (p.type ? `: ${formatType(p.type)}` : ''));
    const params = [fn.hasSelf ? 'self' : '', ...rest].filter(Boolean).join(', ');
    const ret = fn.returnType ? `: ${formatType(fn.returnType)}` : '';
    this.line(`${mods}${fn.name}(${params})${ret} {`);
    this.emitBlockBody(fn.body);
    this.line('}');
  }

  private emitStruct(s: StructDecl): void {
    const tp = s.typeParams?.length ? `<${s.typeParams.join(', ')}>` : '';
    const header = `${s.isPub ? 'pub ' : ''}struct ${s.name}${tp}`;
    if (s.fields.length === 0 && s.methods.length === 0) {
      this.line(`${header} {}`);
      return;
    }
    this.line(`${header} {`);
    this.depth++;
    for (const f of s.fields) this.line(`${f.name}: ${formatType(f.type)},`);
    for (const m of s.methods) {
      this.line('');
      this.emitMethod(m);
    }
    this.depth--;
    this.line('}');
  }

  private emitEnum(e: EnumDecl): void {
    const tp = e.typeParams?.length ? `<${e.typeParams.join(', ')}>` : '';
    const header = `${e.isPub ? 'pub ' : ''}enum ${e.name}${tp}`;
    if (e.variants.length === 0) {
      this.line(`${header} {}`);
      return;
    }
    this.line(`${header} {`);
    this.depth++;
    for (const v of e.variants) {
      const payload = v.fields?.length ? `(${v.fields.map(formatType).join(', ')})` : '';
      this.line(`${v.name}${payload},`);
    }
    this.depth--;
    this.line('}');
  }

  private emitImport(stmt: any): void {
    const kw = stmt.isUnsafe ? 'import unsafe' : 'import';
    this.line(`${kw} { ${stmt.names.join(', ')} } from ${JSON.stringify(stmt.from)};`);
  }

  // ── statements ────────────────────────────────────────────────────────

  private emitBlockBody(block: Block): void {
    this.depth++;
    for (const stmt of block.statements) {
      this.flushStandaloneBefore(this.lineOf(stmt));
      this.emitStmt(stmt);
    }
    this.depth--;
  }

  private emitStmt(stmt: Stmt): void {
    const ln = this.lineOf(stmt);
    switch (stmt.kind) {
      case 'let': {
        const mut = stmt.mutable ? 'mut ' : '';
        const ann = stmt.typeAnnotation ? `: ${formatType(stmt.typeAnnotation)}` : '';
        this.line(`let ${mut}${stmt.name}${ann} = ${this.expr(stmt.init)};` + this.trailingFor(ln));
        return;
      }
      case 'return': {
        const v = stmt.value ? ` ${this.expr(stmt.value)}` : '';
        this.line(`return${v};` + this.trailingFor(ln));
        return;
      }
      case 'expr': {
        if (stmt.expr.kind === 'match') { this.emitMatch(stmt.expr as MatchExpr); return; }
        // A trailing unsafe block (its value is the block's) reads best on its
        // own lines rather than collapsed inline.
        if (stmt.expr.kind === 'unsafe_expr') { this.emitUnsafe(stmt.expr.body); return; }
        this.line(`${this.expr(stmt.expr)};` + this.trailingFor(ln));
        return;
      }
      case 'if': return this.emitIf(stmt);
      case 'while':
        this.line(`while ${this.expr(stmt.cond)} {`);
        this.emitBlockBody(stmt.body);
        this.line('}');
        return;
      case 'for':
        this.line(`for ${stmt.varName} in ${this.expr(stmt.iterable)} {`);
        this.emitBlockBody(stmt.body);
        this.line('}');
        return;
      case 'block':
        this.line('{');
        this.emitBlockBody(stmt);
        this.line('}');
        return;
      case 'unsafe':
        this.emitUnsafe(stmt.body);
        return;
    }
  }

  private emitIf(stmt: any): void {
    this.line(`if ${this.expr(stmt.cond)} {`);
    this.emitBlockBody(stmt.thenBranch);
    this.emitElse(stmt.elseBranch);
  }

  private emitElse(branch: any): void {
    if (!branch) { this.line('}'); return; }
    if (branch.kind === 'if') {
      this.line(`} else if ${this.expr(branch.cond)} {`);
      this.emitBlockBody(branch.thenBranch);
      this.emitElse(branch.elseBranch);
    } else {
      this.line('} else {');
      this.emitBlockBody(branch);
      this.line('}');
    }
  }

  private emitUnsafe(body: string): void {
    this.line('unsafe {');
    this.depth++;
    for (const l of dedent(body)) this.line(l);
    this.depth--;
    this.line('}');
  }

  // Match arm bodies are always blocks in NovaScript, so every arm renders in
  // brace form.
  private emitMatch(m: MatchExpr): void {
    this.line(`match ${this.expr(m.expr)} {`);
    this.depth++;
    for (const arm of m.arms) {
      const guard = arm.guard ? ` if ${this.expr(arm.guard)}` : '';
      const head = `${formatPattern(arm.pattern)}${guard} =>`;
      if (arm.body.statements.length === 0) {
        this.line(`${head} {},`);
      } else {
        this.line(`${head} {`);
        this.emitBlockBody(arm.body);
        this.line('},');
      }
    }
    this.depth--;
    this.line('}');
  }

  private stmtInline(stmt: Stmt): string {
    if (stmt.kind === 'expr') return this.expr(stmt.expr);
    if (stmt.kind === 'return') return `return${stmt.value ? ' ' + this.expr(stmt.value) : ''}`;
    if (stmt.kind === 'let') {
      const mut = stmt.mutable ? 'mut ' : '';
      return `let ${mut}${stmt.name} = ${this.expr(stmt.init)}`;
    }
    return '';
  }

  // ── expressions ───────────────────────────────────────────────────────

  private expr(e: Expr, parentPrec = 0): string {
    switch (e.kind) {
      case 'literal':
        if (typeof e.value === 'string') return JSON.stringify(e.value);
        return String(e.value);
      case 'identifier':
        return e.name;
      case 'binary': {
        const prec = PREC[e.op] ?? 0;
        const left = this.expr(e.left, prec);
        const right = this.expr(e.right, prec + 1); // left-assoc: right needs tighter
        const s = e.op === '=' ? `${left} = ${right}` : `${left} ${e.op} ${right}`;
        return prec < parentPrec ? `(${s})` : s;
      }
      case 'unary':
        return `${e.op}${this.expr(e.operand, 7)}`;
      case 'call':
        return `${this.expr(e.callee, 8)}(${e.args.map(a => this.expr(a)).join(', ')})`;
      case 'member':
        return `${this.expr(e.object, 8)}.${e.property}`;
      case 'index':
        return `${this.expr(e.object, 8)}[${this.expr(e.index)}]`;
      case 'postfix': {
        const base = this.expr(e.expr, 8);
        if (e.op === '.unwrap_or' || e.op === '.catch') return `${base}${e.op}(${e.arg ? this.expr(e.arg) : ''})`;
        return `${base}${e.op}`;
      }
      case 'range':
        return `${this.expr(e.start, 5)}..${this.expr(e.end, 5)}`;
      case 'tuple_expr':
        return `(${e.elements.map(el => this.expr(el)).join(', ')})`;
      case 'template':
        return this.template(e.parts);
      case 'array':
        return `[${e.elements.map(el => this.expr(el)).join(', ')}]`;
      case 'object': {
        const fields = e.fields.map(f => `${f.name}: ${this.expr(f.value)}`).join(', ');
        const name = e.typeName ? `${e.typeName} ` : '';
        return e.fields.length ? `${name}{ ${fields} }` : `${name}{}`;
      }
      case 'unsafe_expr':
        return `unsafe { ${e.body} }`;
      case 'closure':
        return this.closure(e);
      case 'match':
        return this.matchInline(e);
    }
  }

  // `fn x => body` for a single bare param, else `fn (a, b) => body`.
  private closure(e: Extract<Expr, { kind: 'closure' }>): string {
    const single = e.params.length === 1 && !e.params[0].type;
    const params = single
      ? e.params[0].name
      : `(${e.params.map(p => p.name + (p.type ? `: ${formatType(p.type)}` : '')).join(', ')})`;
    const body = e.body.kind === 'block'
      ? this.blockInline(e.body)
      : this.expr(e.body);
    return `fn ${params} => ${body}`;
  }

  // Render a block body compactly for an inline closure.
  private blockInline(block: Block): string {
    if (block.statements.length === 0) return '{}';
    const parts = block.statements.map(s => this.stmtInline(s)).filter(Boolean);
    return `{ ${parts.join('; ')} }`;
  }

  // A match used as a value: render compactly with brace-form arms so it stays
  // on manageable lines and reparses.
  private matchInline(m: MatchExpr): string {
    const arms = m.arms.map(arm => {
      const guard = arm.guard ? ` if ${this.expr(arm.guard)}` : '';
      const body = arm.body.statements.length === 0
        ? '{}'
        : `{ ${arm.body.statements.map(s => this.stmtInline(s)).filter(Boolean).join('; ')} }`;
      return `${formatPattern(arm.pattern)}${guard} => ${body}`;
    });
    return `match ${this.expr(m.expr)} { ${arms.join(', ')} }`;
  }

  private template(parts: TemplatePart[]): string {
    let s = '`';
    for (const p of parts) {
      if (p.kind === 'text') s += p.value;
      else s += '${' + this.expr(p.expr) + '}';
    }
    return s + '`';
  }
}

// ── standalone printers ─────────────────────────────────────────────────

function commentText(c: Comment): string {
  return c.text === '' ? '//' : `// ${c.text}`;
}

export function formatType(ann: TypeAnnotation): string {
  switch (ann.kind) {
    case 'num': return 'num';
    case 'str': return 'str';
    case 'bool': return 'bool';
    case 'void': return 'void';
    case 'generic': return ann.name;
    case 'option': return `Option<${formatType(ann.inner)}>`;
    case 'result': return `Result<${formatType(ann.ok)}, ${formatType(ann.err)}>`;
    case 'array': return `${formatType(ann.element)}[]`;
    case 'function': return `(${ann.params.map(formatType).join(', ')}): ${formatType(ann.ret)}`;
    case 'nominal': {
      const args = ann.typeArgs?.length ? `<${ann.typeArgs.map(formatType).join(', ')}>` : '';
      return `${ann.name}${args}`;
    }
  }
}

function formatPattern(p: Pattern): string {
  switch (p.kind) {
    case 'wildcard': return '_';
    case 'literal': return typeof p.value === 'string' ? JSON.stringify(p.value) : String(p.value);
    case 'identifier': return p.name;
    case 'enum_variant': return p.args.length ? `${p.name}(${p.args.join(', ')})` : p.name;
    case 'struct_pattern': {
      const fields = p.fields.map(f => f.name === f.bind ? f.name : `${f.name}: ${f.bind}`).join(', ');
      return `${p.name} { ${fields} }`;
    }
    case 'tuple': return `(${p.elements.map(formatPattern).join(', ')})`;
  }
}

// Normalize a raw unsafe body for re-indentation under the current depth.
//
// The parser trims the captured body, so its first line already sits at column
// 0 (the block's base level). Subsequent lines keep their original absolute
// indentation, so we measure the common indent of *those* lines and strip it —
// this both preserves the inner structure and makes formatting idempotent
// (a second pass sees the depth indent as the new common prefix and removes it).
function dedent(body: string): string[] {
  const lines = body.split('\n');
  if (lines.length <= 1) return lines.map(l => l.trimEnd());
  const rest = lines.slice(1).filter(l => l.trim().length > 0);
  const min = rest.length ? Math.min(...rest.map(l => l.match(/^\s*/)![0].length)) : 0;
  return lines.map((l, i) => (i === 0 ? l.trimEnd() : l.slice(min).trimEnd()));
}
