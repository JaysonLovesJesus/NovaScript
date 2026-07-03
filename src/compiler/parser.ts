// Parser for NovaScript

import { Token, TokenType, tokenize } from './lexer.js';
import type {
  Program, Expr, Stmt, FunctionDecl, StructDecl, EnumDecl,
  TypeAnnotation, Pattern, MatchArm, EnumVariant, Block, LetStmt, ImportStmt,
  ForStmt, TemplateLiteral, TemplatePart
} from './ast.js';
import { 
  ReturnStmt, IfStmt, WhileStmt, ExprStmt,
  UnsafeBlock, MatchExpr, PostfixExpr, ObjectLiteral, ArrayLiteral
} from './ast.js';

export class ParseError extends Error {
  constructor(message: string, public token: Token) {
    super(`[${token.line}:${token.column}] ${message}`);
  }
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  private source: string;
  private lineStarts: number[];

  constructor(source: string) {
    this.source = source;
    this.tokens = tokenize(source);
    this.lineStarts = [0];
    for (let i = 0; i < source.length; i++) {
      if (source[i] === '\n') this.lineStarts.push(i + 1);
    }
  }

  private offsetOf(token: Token): number {
    return (this.lineStarts[token.line - 1] ?? 0) + token.column - 1;
  }

  private current(): Token { return this.tokens[this.pos]; }
  private peek(offset = 0): Token { return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)]; }
  private advance(): Token { const t = this.current(); if (this.current().type !== TokenType.EOF) this.pos++; return t; }
  private expect(type: TokenType): Token { const t = this.current(); if (t.type !== type) throw new ParseError(`Expected ${type}, got ${t.type}`, t); return this.advance(); }
  private match(...types: TokenType[]): boolean { return types.includes(this.current().type); }

  parse(): Program {
    const declarations: (FunctionDecl | StructDecl | EnumDecl)[] = [];
    const statements: (Stmt | ImportStmt)[] = [];
    while (!this.match(TokenType.EOF)) {
      if (this.startsDeclaration()) {
        // Modifier prefix: `pub`? then `async`/`comptime`? then fn/struct/enum
        let isPub = false, isAsync = false, isComptime = false;
        if (this.match(TokenType.PUB)) { this.advance(); isPub = true; }
        if (this.match(TokenType.ASYNC)) { this.advance(); isAsync = true; }
        else if (this.match(TokenType.COMPTIME)) { this.advance(); isComptime = true; }
        if (this.match(TokenType.FN)) {
          const fn = this.parseFunctionDecl();
          fn.isPub = isPub;
          fn.isAsync = isAsync;
          fn.isComptime = isComptime;
          declarations.push(fn);
        } else if (this.match(TokenType.STRUCT)) {
          const s = this.parseStructDecl();
          s.isPub = isPub;
          declarations.push(s);
        } else if (this.match(TokenType.ENUM)) {
          const e = this.parseEnumDecl();
          e.isPub = isPub;
          declarations.push(e);
        } else {
          throw new ParseError('Expected fn, struct, or enum', this.current());
        }
      } else if (this.match(TokenType.IMPORT)) statements.push(this.parseImport());
      else statements.push(this.parseStatement());
    }
    return { kind: 'program', declarations, statements };
  }

  // A top-level declaration begins with `fn`/`struct`/`enum`, optionally
  // prefixed by `pub`, `async`, or `comptime`.
  private startsDeclaration(): boolean {
    if (this.match(TokenType.FN, TokenType.STRUCT, TokenType.ENUM)) return true;
    if (this.match(TokenType.PUB)) return true;
    if (this.match(TokenType.ASYNC, TokenType.COMPTIME)) return this.peek(1).type === TokenType.FN;
    return false;
  }

  private parseStatement(): Stmt {
    if (this.match(TokenType.LET)) return this.parseLetStmt();
    if (this.match(TokenType.RETURN)) {
      this.advance();
      const value = this.match(TokenType.SEMICOLON, TokenType.RBRACE) ? undefined : this.parseExpression();
      this.expect(TokenType.SEMICOLON);
      return { kind: 'return', value };
    }
    if (this.match(TokenType.IF)) return this.parseIfStmt();
    if (this.match(TokenType.WHILE)) return this.parseWhileStmt();
    if (this.match(TokenType.FOR)) return this.parseForStmt();
    if (this.match(TokenType.UNSAFE)) {
      const body = this.captureUnsafeBody();
      // Trailing unsafe in a block is a value: fn f(): num { unsafe { ... } }
      if (this.match(TokenType.RBRACE)) {
        return { kind: 'expr', expr: { kind: 'unsafe_expr', body } };
      }
      return { kind: 'unsafe', body };
    }
    const expr = this.parseExpression();
    if (this.match(TokenType.SEMICOLON)) this.advance();
    return { kind: 'expr', expr };
  }

  private parseTypeAnnotation(): TypeAnnotation | undefined {
    if (!this.match(TokenType.COLON)) return undefined;
    this.advance();
    return this.parseType();
  }

  private parseType(): TypeAnnotation {
    let type = this.parseBaseType();
    while (this.match(TokenType.LBRACKET) && this.peek(1).type === TokenType.RBRACKET) {
      this.advance();
      this.advance();
      type = { kind: 'array', element: type };
    }
    return type;
  }

  private parseBaseType(): TypeAnnotation {
    if (this.match(TokenType.NUM)) { this.advance(); return { kind: 'num' }; }
    if (this.match(TokenType.STR)) { this.advance(); return { kind: 'str' }; }
    if (this.match(TokenType.BOOL)) { this.advance(); return { kind: 'bool' }; }
    if (this.match(TokenType.VOID)) { this.advance(); return { kind: 'void' }; }
    if (this.match(TokenType.OPTION)) {
      this.advance(); this.expect(TokenType.LT);
      const inner = this.parseType();
      this.expect(TokenType.GT);
      return { kind: 'option', inner };
    }
    if (this.match(TokenType.RESULT)) {
      this.advance(); this.expect(TokenType.LT);
      const ok = this.parseType();
      this.expect(TokenType.COMMA);
      const err = this.parseType();
      this.expect(TokenType.GT);
      return { kind: 'result', ok, err };
    }
    if (this.match(TokenType.IDENT)) {
      const name = this.advance().value;
      // Long-form aliases for the primitive keywords
      if (name === 'string') return { kind: 'str' };
      if (name === 'number') return { kind: 'num' };
      if (name === 'boolean') return { kind: 'bool' };
      let typeArgs: TypeAnnotation[] | undefined;
      if (this.match(TokenType.LT)) {
        this.advance();
        typeArgs = [];
        do { typeArgs.push(this.parseType()); } while (this.match(TokenType.COMMA) && this.advance());
        this.expect(TokenType.GT);
      }
      return { kind: 'nominal', name, typeArgs };
    }
    throw new ParseError('Expected type annotation', this.current());
  }

  private parseTypeParams(): string[] | undefined {
    if (!this.match(TokenType.LT)) return undefined;
    this.advance();
    const names: string[] = [];
    do { names.push(this.expect(TokenType.IDENT).value); } while (this.match(TokenType.COMMA) && this.advance());
    this.expect(TokenType.GT);
    return names;
  }

  private parseFunctionDecl(): FunctionDecl {
    this.expect(TokenType.FN);
    const name = this.expect(TokenType.IDENT).value;
    const typeParams = this.parseTypeParams();
    this.expect(TokenType.LPAREN);
    const params: { name: string; type?: TypeAnnotation }[] = [];
    if (!this.match(TokenType.RPAREN)) {
      do {
        const paramName = this.expect(TokenType.IDENT).value;
        params.push({ name: paramName, type: this.parseTypeAnnotation() });
      } while (this.match(TokenType.COMMA) && this.advance());
    }
    this.expect(TokenType.RPAREN);
    return { kind: 'function', name, typeParams, params, returnType: this.parseTypeAnnotation(), body: this.parseBlock(), isPub: false, isComptime: false };
  }

  private parseStructDecl(): StructDecl {
    this.expect(TokenType.STRUCT);
    const name = this.expect(TokenType.IDENT).value;
    const typeParams = this.parseTypeParams();
    this.expect(TokenType.LBRACE);
    const fields: { name: string; type: TypeAnnotation }[] = [];
    const methods: FunctionDecl[] = [];
    while (!this.match(TokenType.RBRACE)) {
      // pub marks exported declarations (fn/struct/enum/method), not fields —
      // fields carry no visibility of their own
      let methodIsPub = false;
      let methodIsAsync = false;
      let pubToken: Token | undefined;
      if (this.match(TokenType.PUB)) { pubToken = this.advance(); methodIsPub = true; }
      if (this.match(TokenType.ASYNC)) { this.advance(); methodIsAsync = true; }
      const fieldName = this.expect(TokenType.IDENT).value;
      if (this.match(TokenType.COLON)) {
        if (methodIsPub) throw new ParseError("'pub' cannot be applied to a field", pubToken!);
        fields.push({ name: fieldName, type: this.parseTypeAnnotation()! });
        this.consumeFieldSeparator();
      } else if (this.match(TokenType.LPAREN)) {
        methods.push(this.parseMethod(methodIsPub, methodIsAsync));
      } else throw new ParseError('Expected colon or parenthesis', this.current());
    }
    this.expect(TokenType.RBRACE);
    return { kind: 'struct', name, typeParams, fields, methods, isPub: false };
  }

  // Struct members may be separated by ',' or ';' (or nothing before '}')
  private consumeFieldSeparator(): void {
    if (this.match(TokenType.COMMA, TokenType.SEMICOLON)) this.advance();
  }

  private parseMethod(isPub: boolean, isAsync: boolean): FunctionDecl {
    const name = this.peek(-1).value;
    this.expect(TokenType.LPAREN);
    const params: { name: string; type?: TypeAnnotation }[] = [];
    let hasSelf = false;
    if (this.match(TokenType.SELF)) {
      this.advance();
      hasSelf = true;
      if (this.match(TokenType.COMMA)) this.advance();
    }
    if (!this.match(TokenType.RPAREN)) {
      do {
        params.push({ name: this.expect(TokenType.IDENT).value, type: this.parseTypeAnnotation() });
      } while (this.match(TokenType.COMMA) && this.advance());
    }
    this.expect(TokenType.RPAREN);
    return { kind: 'function', name, params, returnType: this.parseTypeAnnotation(), body: this.parseBlock(), isPub, isAsync, isComptime: false, hasSelf };
  }

  private parseEnumDecl(): EnumDecl {
    this.expect(TokenType.ENUM);
    // Option/Result are lexed as keywords but are legal enum names (prelude defines them)
    const name = this.match(TokenType.IDENT, TokenType.OPTION, TokenType.RESULT)
      ? this.advance().value
      : this.expect(TokenType.IDENT).value;
    const typeParams = this.parseTypeParams();
    this.expect(TokenType.LBRACE);
    const variants: EnumVariant[] = [];
    while (!this.match(TokenType.RBRACE)) {
      const variantName = this.expect(TokenType.IDENT).value;
      let fields: TypeAnnotation[] | undefined;
      if (this.match(TokenType.LPAREN)) {
        this.advance(); fields = [];
        if (!this.match(TokenType.RPAREN)) {
          do { fields!.push(this.parseType()); } while (this.match(TokenType.COMMA) && this.advance());
        }
        this.expect(TokenType.RPAREN);
      }
      variants.push({ name: variantName, fields });
      if (!this.match(TokenType.COMMA)) break;
      this.advance();
    }
    this.expect(TokenType.RBRACE);
    return { kind: 'enum', name, variants, isPub: false, typeParams };
  }

  private parseImport(): ImportStmt {
    this.expect(TokenType.IMPORT);
    let isUnsafe = false;
    if (this.match(TokenType.UNSAFE)) { this.advance(); isUnsafe = true; }
    this.expect(TokenType.LBRACE);
    const names: string[] = [];
    if (!this.match(TokenType.RBRACE)) {
      do { names.push(this.expect(TokenType.IDENT).value); } while (this.match(TokenType.COMMA) && this.advance());
    }
    this.expect(TokenType.RBRACE);
    this.expect(TokenType.FROM);
    const from = this.expect(TokenType.STRING).value;
    this.expect(TokenType.SEMICOLON);
    return { kind: 'import', names, from, isUnsafe };
  }

  private parseLetStmt(): LetStmt {
    this.expect(TokenType.LET);
    let mutable = false;
    if (this.match(TokenType.MUT)) { this.advance(); mutable = true; }
    const name = this.expect(TokenType.IDENT).value;
    const typeAnnotation = this.parseTypeAnnotation();
    this.expect(TokenType.EQ);
    const init = this.parseExpression();
    this.expect(TokenType.SEMICOLON);
    return { kind: 'let', mutable, name, typeAnnotation, init };
  }

  // The body is sliced verbatim from the source so raw JS (?., ??, template
  // literals, string quoting) survives untouched
  private captureUnsafeBody(): string {
    this.expect(TokenType.UNSAFE); this.expect(TokenType.LBRACE);
    const startToken = this.current();
    let closing = startToken;
    let braceCount = 1;
    while (braceCount > 0 && !this.match(TokenType.EOF)) {
      const token = this.advance();
      if (token.type === TokenType.LBRACE) braceCount++;
      else if (token.type === TokenType.RBRACE) {
        braceCount--;
        if (braceCount === 0) closing = token;
      }
    }
    return this.source.slice(this.offsetOf(startToken), this.offsetOf(closing)).trim();
  }

  private parseUnsafeBlock(): UnsafeBlock {
    return { kind: 'unsafe', body: this.captureUnsafeBody() };
  }

  private parseBlock(): Block {
    this.expect(TokenType.LBRACE);
    const statements: Stmt[] = [];
    while (!this.match(TokenType.RBRACE)) {
      statements.push(this.parseStatement());
    }
    this.expect(TokenType.RBRACE);
    return { kind: 'block', statements };
  }

  private parseIfStmt(): IfStmt {
    this.expect(TokenType.IF);
    const cond = this.parseExpression();
    const thenBranch = this.parseBlock();
    let elseBranch: Block | IfStmt | undefined;
    if (this.match(TokenType.ELSE)) {
      this.advance();
      elseBranch = this.match(TokenType.IF) ? this.parseIfStmt() : this.parseBlock();
    }
    return { kind: 'if', cond, thenBranch, elseBranch };
  }

  private parseWhileStmt(): WhileStmt {
    this.expect(TokenType.WHILE);
    return { kind: 'while', cond: this.parseExpression(), body: this.parseBlock() };
  }

  private parseForStmt(): ForStmt {
    this.expect(TokenType.FOR);
    const varName = this.expect(TokenType.IDENT).value;
    this.expect(TokenType.IN);
    const iterable = this.parseExpression();
    return { kind: 'for', varName, iterable, body: this.parseBlock() };
  }

  private parseMatchExpr(): MatchExpr {
    this.expect(TokenType.MATCH);
    const expr = this.parseExpression();
    this.expect(TokenType.LBRACE);
    const arms: MatchArm[] = [];
    while (!this.match(TokenType.RBRACE)) {
      const pattern = this.parsePattern();
      let guard: Expr | undefined;
      if (this.match(TokenType.IF)) { this.advance(); guard = this.parseExpression(); }
      this.expect(TokenType.FAT_ARROW);
      // Arm body is a block; `=> unsafe { ... }` is sugar for a block holding
      // a single unsafe statement
      const body: Block = this.match(TokenType.UNSAFE)
        ? { kind: 'block', statements: [{ kind: 'unsafe', body: this.captureUnsafeBody() }] }
        : this.parseBlock();
      arms.push({ pattern, guard, body });
      if (!this.match(TokenType.COMMA)) break;
      this.advance();
    }
    this.expect(TokenType.RBRACE);
    return { kind: 'match', expr, arms };
  }

  private parsePattern(): Pattern {
    if (this.match(TokenType.LPAREN)) {
      this.advance();
      const elements: Pattern[] = [];
      if (!this.match(TokenType.RPAREN)) {
        do { elements.push(this.parsePattern()); } while (this.match(TokenType.COMMA) && this.advance());
      }
      this.expect(TokenType.RPAREN);
      return elements.length === 1 ? elements[0] : { kind: 'tuple', elements };
    }
    if (this.match(TokenType.IDENT)) {
      const name = this.advance().value;
      if (name === '_') return { kind: 'wildcard' };
      if (this.match(TokenType.LPAREN)) {
        this.advance();
        const args: string[] = [];
        if (!this.match(TokenType.RPAREN)) {
          do { args.push(this.expect(TokenType.IDENT).value); } while (this.match(TokenType.COMMA) && this.advance());
        }
        this.expect(TokenType.RPAREN);
        return { kind: 'enum_variant', name, args };
      }
      if (this.match(TokenType.LBRACE)) {
        this.advance();
        const fields: { name: string; bind: string }[] = [];
        if (!this.match(TokenType.RBRACE)) {
          do {
            const fieldName = this.expect(TokenType.IDENT).value;
            this.expect(TokenType.COLON);
            fields.push({ name: fieldName, bind: this.expect(TokenType.IDENT).value });
          } while (this.match(TokenType.COMMA) && this.advance());
        }
        this.expect(TokenType.RBRACE);
        return { kind: 'struct_pattern', name, fields };
      }
      return { kind: 'identifier', name };
    }
    if (this.match(TokenType.NUMBER)) return { kind: 'literal', value: Number(this.advance().value) };
    if (this.match(TokenType.STRING)) return { kind: 'literal', value: this.advance().value };
    if (this.match(TokenType.TRUE)) { this.advance(); return { kind: 'literal', value: true }; }
    if (this.match(TokenType.FALSE)) { this.advance(); return { kind: 'literal', value: false }; }
    throw new ParseError('Expected pattern', this.current());
  }

  private parseExpression(): Expr { return this.parseAssignment(); }

  private parseAssignment(): Expr {
    const left = this.parseLogicalOr();
    if (this.match(TokenType.EQ) && (left.kind === 'identifier' || left.kind === 'member' || left.kind === 'index')) {
      this.advance();
      return { kind: 'binary', left, op: '=', right: this.parseExpression() };
    }
    return left;
  }

  private parseLogicalOr(): Expr {
    let left = this.parseLogicalAnd();
    while (this.match(TokenType.OR)) {
      const op = this.advance().value;
      left = { kind: 'binary', left, op, right: this.parseLogicalAnd() };
    }
    return left;
  }

  private parseLogicalAnd(): Expr {
    let left = this.parseEquality();
    while (this.match(TokenType.AND)) {
      const op = this.advance().value;
      left = { kind: 'binary', left, op, right: this.parseEquality() };
    }
    return left;
  }

  private parseEquality(): Expr {
    let left = this.parseComparison();
    while (this.match(TokenType.EQEQ, TokenType.NEQ)) {
      const op = this.advance().value;
      left = { kind: 'binary', left, op, right: this.parseComparison() };
    }
    return left;
  }

  private parseComparison(): Expr {
    let left = this.parseRange();
    while (this.match(TokenType.LT, TokenType.GT, TokenType.LTE, TokenType.GTE)) {
      const op = this.advance().value;
      left = { kind: 'binary', left, op, right: this.parseRange() };
    }
    return left;
  }

  private parseRange(): Expr {
    const left = this.parseAdditive();
    if (this.match(TokenType.DOTDOT)) {
      this.advance();
      return { kind: 'range', start: left, end: this.parseAdditive() };
    }
    return left;
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.match(TokenType.PLUS, TokenType.MINUS)) {
      const op = this.advance().value;
      left = { kind: 'binary', left, op, right: this.parseMultiplicative() };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parsePostfix();
    while (this.match(TokenType.STAR, TokenType.SLASH, TokenType.PERCENT)) {
      const op = this.advance().value;
      left = { kind: 'binary', left, op, right: this.parsePostfix() };
    }
    return left;
  }

  private parsePostfix(): Expr {
    let expr = this.parseUnary();
    while (true) {
      if (this.match(TokenType.DOT)) {
        this.advance();
        if (this.match(TokenType.IDENT)) {
          const next = this.peek().value;
          if (next === 'await') { this.advance(); expr = { kind: 'postfix', expr, op: '.await' }; continue; }
          if (next === 'try') { this.advance(); expr = { kind: 'postfix', expr, op: '.try' }; continue; }
          if (next === 'catch') { this.advance(); expr = { kind: 'postfix', expr, op: '.catch' }; continue; }
          if (next === 'unwrap') { this.advance(); expr = { kind: 'postfix', expr, op: '.unwrap' }; continue; }
          if (next === 'unwrap_or') {
            this.advance(); this.expect(TokenType.LPAREN);
            const arg = this.parseExpression();
            this.expect(TokenType.RPAREN);
            expr = { kind: 'postfix', expr, op: '.unwrap_or', arg };
            continue;
          }
        }
        if (this.match(TokenType.IDENT)) {
          const prop = this.advance().value;
          if (this.match(TokenType.LPAREN)) {
            this.advance();
            const args: Expr[] = [];
            if (!this.match(TokenType.RPAREN)) {
              do { args.push(this.parseExpression()); } while (this.match(TokenType.COMMA) && this.advance());
            }
            this.expect(TokenType.RPAREN);
            expr = { kind: 'call', callee: { kind: 'member', object: expr, property: prop }, args };
          } else {
            expr = { kind: 'member', object: expr, property: prop };
          }
          continue;
        }
        break;
      }
      if (this.match(TokenType.QUESTION)) { this.advance(); expr = { kind: 'postfix', expr, op: '?' }; continue; }
      if (this.match(TokenType.LBRACKET)) {
        this.advance();
        const index = this.parseExpression();
        this.expect(TokenType.RBRACKET);
        expr = { kind: 'index', object: expr, index };
        continue;
      }
      break;
    }
    return expr;
  }

  private parseUnary(): Expr {
    if (this.match(TokenType.MINUS, TokenType.NOT)) {
      const op = this.advance().value;
      return { kind: 'unary', op, operand: this.parseUnary() };
    }
    return this.parseCall();
  }

  private parseCall(): Expr {
    let expr = this.parsePrimary();
    while (this.match(TokenType.LPAREN)) {
      this.advance();
      const args: Expr[] = [];
      if (!this.match(TokenType.RPAREN)) {
        do { args.push(this.parseExpression()); } while (this.match(TokenType.COMMA) && this.advance());
      }
      this.expect(TokenType.RPAREN);
      expr = { kind: 'call', callee: expr, args };
    }
    return expr;
  }

  private parsePrimary(): Expr {
    if (this.match(TokenType.NUMBER)) return { kind: 'literal', value: Number(this.advance().value) };
    if (this.match(TokenType.STRING)) return { kind: 'literal', value: this.advance().value };
    if (this.match(TokenType.TEMPLATE)) return this.parseTemplate(this.advance().value);
    if (this.match(TokenType.TRUE)) { this.advance(); return { kind: 'literal', value: true }; }
    if (this.match(TokenType.FALSE)) { this.advance(); return { kind: 'literal', value: false }; }
    if (this.match(TokenType.SELF)) { this.advance(); return { kind: 'identifier', name: 'self' }; }
    if (this.match(TokenType.IDENT)) {
      // Struct literal `Vec2 { x: 1 }`: uppercase name followed by `{ ident:`
      // or `{}`. The lookahead avoids swallowing blocks (`match s { ... }`).
      if (this.isStructLiteralAhead()) {
        const typeName = this.advance().value;
        this.advance(); // {
        const fields = this.parseObjectFields();
        this.expect(TokenType.RBRACE);
        return { kind: 'object', fields, typeName };
      }
      return { kind: 'identifier', name: this.advance().value };
    }
    if (this.match(TokenType.LPAREN)) {
      this.advance();
      // Unit value `()` — the void placeholder, e.g. Ok(())
      if (this.match(TokenType.RPAREN)) {
        this.advance();
        return { kind: 'identifier', name: 'undefined' };
      }
      const first = this.parseExpression();
      if (this.match(TokenType.COMMA)) {
        const elements = [first];
        while (this.match(TokenType.COMMA)) {
          this.advance();
          elements.push(this.parseExpression());
        }
        this.expect(TokenType.RPAREN);
        return { kind: 'tuple_expr', elements };
      }
      this.expect(TokenType.RPAREN);
      return first;
    }
    if (this.match(TokenType.LBRACKET)) {
      this.advance();
      const elements: Expr[] = [];
      if (!this.match(TokenType.RBRACKET)) {
        do { elements.push(this.parseExpression()); } while (this.match(TokenType.COMMA) && this.advance());
      }
      this.expect(TokenType.RBRACKET);
      return { kind: 'array', elements };
    }
    if (this.match(TokenType.LBRACE)) {
      this.advance();
      const fields = this.parseObjectFields();
      this.expect(TokenType.RBRACE);
      return { kind: 'object', fields };
    }
    if (this.match(TokenType.MATCH)) return this.parseMatchExpr();
    if (this.match(TokenType.UNSAFE)) return { kind: 'unsafe_expr', body: this.captureUnsafeBody() };
    throw new ParseError('Unexpected token', this.current());
  }

  // Object/struct-literal fields: `name: expr` separated by ',' or ';',
  // trailing separator allowed
  private parseObjectFields(): { name: string; value: Expr }[] {
    const fields: { name: string; value: Expr }[] = [];
    while (!this.match(TokenType.RBRACE)) {
      const name = this.expect(TokenType.IDENT).value;
      this.expect(TokenType.COLON);
      fields.push({ name, value: this.parseExpression() });
      if (this.match(TokenType.COMMA, TokenType.SEMICOLON)) this.advance();
      else break;
    }
    return fields;
  }

  private isStructLiteralAhead(): boolean {
    const name = this.current().value;
    if (!/^[A-Z]/.test(name)) return false;
    if (this.peek(1).type !== TokenType.LBRACE) return false;
    const after = this.peek(2);
    if (after.type === TokenType.RBRACE) return true;
    return after.type === TokenType.IDENT && this.peek(3).type === TokenType.COLON;
  }

  private parseTemplate(raw: string): TemplateLiteral {
    const parts: TemplatePart[] = [];
    let text = '';
    let i = 0;
    while (i < raw.length) {
      if (raw[i] === '\\' && i + 1 < raw.length) {
        const next = raw[i + 1];
        switch (next) {
          case 'n': text += '\n'; break;
          case 't': text += '\t'; break;
          case 'r': text += '\r'; break;
          default: text += next;
        }
        i += 2;
        continue;
      }
      if (raw[i] === '$' && raw[i + 1] === '{') {
        if (text) { parts.push({ kind: 'text', value: text }); text = ''; }
        let depth = 1;
        let j = i + 2;
        let src = '';
        while (j < raw.length && depth > 0) {
          if (raw[j] === '{') depth++;
          else if (raw[j] === '}') { depth--; if (depth === 0) break; }
          src += raw[j];
          j++;
        }
        parts.push({ kind: 'expr', expr: new Parser(src).parseExpression() });
        i = j + 1;
        continue;
      }
      text += raw[i];
      i++;
    }
    if (text) parts.push({ kind: 'text', value: text });
    return { kind: 'template', parts };
  }
}

export function parse(source: string): Program {
  return new Parser(source).parse();
}
