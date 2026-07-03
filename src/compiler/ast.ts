// AST Node Types for NovaScript

export type TypeAnnotation =
  | { kind: 'num' }
  | { kind: 'str' }
  | { kind: 'bool' }
  | { kind: 'void' }
  | { kind: 'generic', name: string }
  | { kind: 'option', inner: TypeAnnotation }
  | { kind: 'result', ok: TypeAnnotation, err: TypeAnnotation }
  | { kind: 'array', element: TypeAnnotation }
  | { kind: 'nominal', name: string, typeArgs?: TypeAnnotation[] };

export interface Literal {
  kind: 'literal';
  value: number | string | boolean;
  type?: TypeAnnotation;
}

export interface Identifier {
  kind: 'identifier';
  name: string;
  type?: TypeAnnotation;
}

export interface BinaryExpr {
  kind: 'binary';
  left: Expr;
  op: string;
  right: Expr;
  type?: TypeAnnotation;
  /** Set by the checker when this operator resolves to a struct method (a + b → a.plus(b)) */
  overloadMethod?: string;
}

export interface UnaryExpr {
  kind: 'unary';
  op: string;
  operand: Expr;
  type?: TypeAnnotation;
}

export interface CallExpr {
  kind: 'call';
  callee: Expr;
  args: Expr[];
  type?: TypeAnnotation;
  /** Set by the checker when obj.func(args) resolves to a free function func(obj, args) */
  ufcs?: boolean;
}

export interface MemberExpr {
  kind: 'member';
  object: Expr;
  property: string;
  type?: TypeAnnotation;
}

export interface PostfixExpr {
  kind: 'postfix';
  expr: Expr;
  op: '.await' | '.try' | '.catch' | '.unwrap' | '.unwrap_or' | '?';
  arg?: Expr;
  type?: TypeAnnotation;
}

export interface IndexExpr {
  kind: 'index';
  object: Expr;
  index: Expr;
  type?: TypeAnnotation;
}

export interface RangeExpr {
  kind: 'range';
  start: Expr;
  end: Expr;
  type?: TypeAnnotation;
}

export interface TupleExpr {
  kind: 'tuple_expr';
  elements: Expr[];
  type?: TypeAnnotation;
}

export type TemplatePart =
  | { kind: 'text'; value: string }
  | { kind: 'expr'; expr: Expr };

export interface TemplateLiteral {
  kind: 'template';
  parts: TemplatePart[];
  type?: TypeAnnotation;
}

export type Expr =
  | Literal
  | Identifier
  | BinaryExpr
  | UnaryExpr
  | CallExpr
  | MemberExpr
  | PostfixExpr
  | ObjectLiteral
  | ArrayLiteral
  | IndexExpr
  | RangeExpr
  | TupleExpr
  | TemplateLiteral
  | UnsafeExpr
  | MatchExpr;

export interface ObjectLiteral {
  kind: 'object';
  fields: { name: string; value: Expr }[];
  typeName?: string;
  type?: TypeAnnotation;
}

export interface ArrayLiteral {
  kind: 'array';
  elements: Expr[];
  type?: TypeAnnotation;
}

export interface LetStmt {
  kind: 'let';
  mutable: boolean;
  name: string;
  typeAnnotation?: TypeAnnotation;
  init: Expr;
}

export interface ReturnStmt {
  kind: 'return';
  value?: Expr;
}

export interface IfStmt {
  kind: 'if';
  cond: Expr;
  thenBranch: Block;
  elseBranch?: Block | IfStmt;
}

export interface WhileStmt {
  kind: 'while';
  cond: Expr;
  body: Block;
}

export interface ForStmt {
  kind: 'for';
  varName: string;
  iterable: Expr;
  body: Block;
}

export interface Block {
  kind: 'block';
  statements: Stmt[];
}

export interface FunctionDecl {
  kind: 'function';
  name: string;
  typeParams?: string[];
  params: { name: string; type?: TypeAnnotation }[];
  returnType?: TypeAnnotation;
  body: Block;
  isPub: boolean;
  isComptime: boolean;
  hasSelf?: boolean;
  /** Set by the checker when the body uses .await (implicit async) */
  isAsync?: boolean;
}

export interface StructDecl {
  kind: 'struct';
  name: string;
  typeParams?: string[];
  fields: { name: string; type: TypeAnnotation }[];
  methods: FunctionDecl[];
  isPub: boolean;
}

export interface EnumVariant {
  name: string;
  fields?: TypeAnnotation[];
}

export interface EnumDecl {
  kind: 'enum';
  name: string;
  variants: EnumVariant[];
  isPub: boolean;
  typeParams?: string[];
}

export interface MatchArm {
  pattern: Pattern;
  guard?: Expr;
  body: Block;
}

export type Pattern =
  | { kind: 'wildcard' }
  | { kind: 'literal', value: number | string | boolean }
  | { kind: 'identifier', name: string }
  | { kind: 'enum_variant', name: string, args: string[] }
  | { kind: 'struct_pattern', name: string, fields: { name: string; bind: string }[] }
  | { kind: 'tuple', elements: Pattern[] };

export interface MatchExpr {
  kind: 'match';
  expr: Expr;
  arms: MatchArm[];
  type?: TypeAnnotation;
  /**
   * Set by lowering when the match is in statement position (its value is
   * discarded). Such a match compiles to a plain if/else chain rather than an
   * IIFE, so `.try`/`?`/`return` inside arms propagate to the enclosing fn.
   */
  stmtPosition?: boolean;
}

export interface UnsafeBlock {
  kind: 'unsafe';
  body: string;
}

/** unsafe { ... } in expression position — raw JS trusted to produce a value */
export interface UnsafeExpr {
  kind: 'unsafe_expr';
  body: string;
  type?: TypeAnnotation;
}

export type Stmt =
  | LetStmt
  | ReturnStmt
  | IfStmt
  | WhileStmt
  | ForStmt
  | Block
  | ExprStmt
  | UnsafeBlock;

export interface ExprStmt {
  kind: 'expr';
  expr: Expr;
}

export interface ImportStmt {
  kind: 'import';
  names: string[];
  from: string;
  isUnsafe: boolean;
}

export interface Program {
  kind: 'program';
  declarations: (FunctionDecl | StructDecl | EnumDecl)[];
  statements: (Stmt | ImportStmt)[];
}
