// Parser for NovaScript

import { Token, TokenType, tokenize } from './lexer.js';
import type { 
  Program, Expr, Stmt, FunctionDecl, StructDecl, EnumDecl,
  TypeAnnotation, Pattern, MatchArm, EnumVariant, Block, LetStmt, ImportStmt
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

  constructor(source: string) {
    this.tokens = tokenize(source);
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
      if (this.match(TokenType.PUB, TokenType.FN, TokenType.STRUCT, TokenType.ENUM)) {
        if (this.match(TokenType.PUB)) this.advance();
        if (this.match(TokenType.FN)) declarations.push(this.parseFunctionDecl());
        else if (this.match(TokenType.STRUCT)) declarations.push(this.parseStructDecl());
        else if (this.match(TokenType.ENUM)) declarations.push(this.parseEnumDecl());
      } else if (this.match(TokenType.IMPORT)) statements.push(this.parseImport());
      else if (this.match(TokenType.LET)) statements.push(this.parseLetStmt());
      else if (this.match(TokenType.UNSAFE)) statements.push(this.parseUnsafeBlock());
      else {
        const expr = this.parseExpression();
        if (this.match(TokenType.SEMICOLON)) this.advance();
        statements.push({ kind: 'expr', expr });
      }
    }
    return { kind: 'program', declarations, statements };
  }

  private parseTypeAnnotation(): TypeAnnotation | undefined {
    if (!this.match(TokenType.COLON)) return undefined;
    this.advance();
    if (this.match(TokenType.NUM)) { this.advance(); return { kind: 'num' }; }
    if (this.match(TokenType.STR)) { this.advance(); return { kind: 'str' }; }
    if (this.match(TokenType.BOOL)) { this.advance(); return { kind: 'bool' }; }
    if (this.match(TokenType.VOID)) { this.advance(); return { kind: 'void' }; }
    if (this.match(TokenType.OPTION)) {
      this.advance(); this.expect(TokenType.LT);
      const inner = this.parseTypeAnnotation() || { kind: 'void' };
      this.expect(TokenType.GT);
      return { kind: 'option', inner };
    }
    if (this.match(TokenType.RESULT)) {
      this.advance(); this.expect(TokenType.LT);
      const ok = this.parseTypeAnnotation() || { kind: 'void' };
      this.expect(TokenType.COMMA);
      const err = this.parseTypeAnnotation() || { kind: 'void' };
      this.expect(TokenType.GT);
      return { kind: 'result', ok, err };
    }
    if (this.match(TokenType.IDENT)) { const name = this.advance().value; return { kind: 'nominal', name }; }
    throw new ParseError('Expected type annotation', this.current());
  }

  private parseFunctionDecl(): FunctionDecl {
    this.expect(TokenType.FN);
    const name = this.expect(TokenType.IDENT).value;
    this.expect(TokenType.LPAREN);
    const params: { name: string; type?: TypeAnnotation }[] = [];
    if (!this.match(TokenType.RPAREN)) {
      do {
        const paramName = this.expect(TokenType.IDENT).value;
        params.push({ name: paramName, type: this.parseTypeAnnotation() });
      } while (this.match(TokenType.COMMA) && this.advance());
    }
    this.expect(TokenType.RPAREN);
    return { kind: 'function', name, params, returnType: this.parseTypeAnnotation(), body: this.parseBlock(), isPub: false, isComptime: false };
  }

  private parseStructDecl(): StructDecl {
    this.expect(TokenType.STRUCT);
    const name = this.expect(TokenType.IDENT).value;
    this.expect(TokenType.LBRACE);
    const fields: { name: string; type: TypeAnnotation; isPub: boolean }[] = [];
    const methods: FunctionDecl[] = [];
    while (!this.match(TokenType.RBRACE)) {
      let fieldIsPub = false;
      if (this.match(TokenType.PUB)) { this.advance(); fieldIsPub = true; }
      const fieldName = this.expect(TokenType.IDENT).value;
      if (this.match(TokenType.COLON)) {
        fields.push({ name: fieldName, type: this.parseTypeAnnotation()!, isPub: fieldIsPub });
        this.expect(TokenType.SEMICOLON);
      } else if (this.match(TokenType.LPAREN)) methods.push(this.parseMethod(fieldIsPub));
      else throw new ParseError('Expected colon or parenthesis', this.current());
    }
    this.expect(TokenType.RBRACE);
    return { kind: 'struct', name, fields, methods, isPub: false };
  }

  private parseMethod(isPub: boolean): FunctionDecl {
    const name = this.peek(-1).value;
    this.expect(TokenType.LPAREN);
    const params: { name: string; type?: TypeAnnotation }[] = [];
    if (!this.match(TokenType.RPAREN)) {
      do {
        params.push({ name: this.expect(TokenType.IDENT).value, type: this.parseTypeAnnotation() });
      } while (this.match(TokenType.COMMA) && this.advance());
    }
    this.expect(TokenType.RPAREN);
    return { kind: 'function', name, params, returnType: this.parseTypeAnnotation(), body: this.parseBlock(), isPub, isComptime: false };
  }

  private parseEnumDecl(): EnumDecl {
    this.expect(TokenType.ENUM);
    const name = this.expect(TokenType.IDENT).value;
    let typeParam: string | undefined;
    if (this.match(TokenType.LT)) { this.advance(); typeParam = this.expect(TokenType.IDENT).value; this.expect(TokenType.GT); }
    this.expect(TokenType.LBRACE);
    const variants: EnumVariant[] = [];
    while (!this.match(TokenType.RBRACE)) {
      const variantName = this.expect(TokenType.IDENT).value;
      let fields: TypeAnnotation[] | undefined;
      if (this.match(TokenType.LPAREN)) {
        this.advance(); fields = [];
        if (!this.match(TokenType.RPAREN)) {
          do { fields!.push(this.parseTypeAnnotation()!); } while (this.match(TokenType.COMMA) && this.advance());
        }
        this.expect(TokenType.RPAREN);
      }
      variants.push({ name: variantName, fields });
      if (!this.match(TokenType.COMMA)) break;
      this.advance();
    }
    this.expect(TokenType.RBRACE);
    return { kind: 'enum', name, variants, isPub: false, typeParam };
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
    const mutable = !!this.match(TokenType.MUT) && this.advance() && true;
    if (this.match(TokenType.MUT)) this.advance();
    const name = this.expect(TokenType.IDENT).value;
    this.expect(TokenType.EQ);
    const init = this.parseExpression();
    this.expect(TokenType.SEMICOLON);
    return { kind: 'let', mutable, name, typeAnnotation: this.parseTypeAnnotation(), init };
  }

  private parseUnsafeBlock(): UnsafeBlock {
    this.expect(TokenType.UNSAFE); this.expect(TokenType.LBRACE);
    let braceCount = 1, body = '';
    while (braceCount > 0 && !this.match(TokenType.EOF)) {
      const token = this.advance();
      if (token.type === TokenType.LBRACE) braceCount++;
      else if (token.type === TokenType.RBRACE) braceCount--;
      if (braceCount > 0) { body += token.value; if (token.type !== TokenType.EOF) body += ' '; }
    }
    return { kind: 'unsafe', body: body.trim() };
  }

  private parseBlock(): Block {
    this.expect(TokenType.LBRACE);
    const statements: Stmt[] = [];
    while (!this.match(TokenType.RBRACE)) {
      if (this.match(TokenType.LET)) statements.push(this.parseLetStmt());
      else if (this.match(TokenType.RETURN)) {
        this.advance();
        const value = this.match(TokenType.SEMICOLON, TokenType.RBRACE) ? undefined : this.parseExpression();
        this.expect(TokenType.SEMICOLON);
        statements.push({ kind: 'return', value });
      } else if (this.match(TokenType.IF)) statements.push(this.parseIfStmt());
      else if (this.match(TokenType.WHILE)) statements.push(this.parseWhileStmt());
      else if (this.match(TokenType.MATCH)) {
        const expr = this.parseMatchExpr();
        if (this.match(TokenType.SEMICOLON)) this.advance();
        statements.push({ kind: 'expr', expr });
      } else if (this.match(TokenType.UNSAFE)) statements.push(this.parseUnsafeBlock());
      else {
        const expr = this.parseExpression();
        if (this.match(TokenType.SEMICOLON)) this.advance();
        statements.push({ kind: 'expr', expr });
      }
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

  private parseMatchExpr(): MatchExpr {
    this.expect(TokenType.MATCH);
    const expr = this.parseExpression();
    this.expect(TokenType.LBRACE);
    const arms: MatchArm[] = [];
    while (!this.match(TokenType.RBRACE)) {
      const pattern = this.parsePattern();
      let guard: Expr | undefined;
      if (this.match(TokenType.IF)) { this.advance(); guard = this.parseExpression(); }
      this.expect(TokenType.ARROW);
      arms.push({ pattern, guard, body: this.parseBlock() });
      if (!this.match(TokenType.COMMA)) break;
      this.advance();
    }
    this.expect(TokenType.RBRACE);
    return { kind: 'match', expr, arms };
  }

  private parsePattern(): Pattern {
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
    if (this.match(TokenType.EQ) && left.kind === 'identifier') {
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
    let left = this.parseAdditive();
    while (this.match(TokenType.LT, TokenType.GT, TokenType.LTE, TokenType.GTE)) {
      const op = this.advance().value;
      left = { kind: 'binary', left, op, right: this.parseAdditive() };
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
    if (this.match(TokenType.TRUE)) { this.advance(); return { kind: 'literal', value: true }; }
    if (this.match(TokenType.FALSE)) { this.advance(); return { kind: 'literal', value: false }; }
    if (this.match(TokenType.IDENT)) return { kind: 'identifier', name: this.advance().value };
    if (this.match(TokenType.LPAREN)) {
      this.advance();
      const expr = this.parseExpression();
      this.expect(TokenType.RPAREN);
      return expr;
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
    if (this.match(TokenType.IDENT) || this.match(TokenType.LBRACE)) {
      const firstToken = this.advance();
      if (firstToken.type === TokenType.IDENT && this.match(TokenType.LBRACE)) {
        const typeName = firstToken.value;
        this.advance();
        const fields: { name: string; value: Expr }[] = [];
        if (!this.match(TokenType.RBRACE)) {
          do {
            const fieldName = this.expect(TokenType.IDENT).value;
            this.expect(TokenType.COLON);
            fields.push({ name: fieldName, value: this.parseExpression() });
          } while (this.match(TokenType.COMMA) && this.advance());
        }
        this.expect(TokenType.RBRACE);
        return { kind: 'object', fields, typeName };
      } else if (firstToken.type === TokenType.LBRACE) {
        const fields: { name: string; value: Expr }[] = [];
        if (!this.match(TokenType.RBRACE)) {
          do {
            const fieldName = this.expect(TokenType.IDENT).value;
            this.expect(TokenType.COLON);
            fields.push({ name: fieldName, value: this.parseExpression() });
          } while (this.match(TokenType.COMMA) && this.advance());
        }
        this.expect(TokenType.RBRACE);
        return { kind: 'object', fields };
      } else {
        return { kind: 'identifier', name: firstToken.value };
      }
    }
    if (this.match(TokenType.MATCH)) return this.parseMatchExpr();
    throw new ParseError('Unexpected token', this.current());
  }
}

export function parse(source: string): Program {
  return new Parser(source).parse();
}
