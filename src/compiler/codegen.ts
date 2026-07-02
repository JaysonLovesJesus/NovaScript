// Code Generator for NovaScript -> JavaScript

import type { 
  Program, Expr, Stmt, FunctionDecl, StructDecl, EnumDecl,
  Pattern, MatchArm, Block, LetStmt, ImportStmt,
  PostfixExpr, ReturnStmt as ReturnStmtType, IfStmt as IfStmtType, WhileStmt as WhileStmtType
} from './ast.js';

export class CodeGenerator {
  private indent = 0;
  private output: string[] = [];

  generate(program: Program): string {
    this.output = [];
    this.indent = 0;

    // Generate declarations first
    for (const decl of program.declarations) {
      if (decl.kind === 'function') {
        this.generateFunction(decl);
      } else if (decl.kind === 'struct') {
        this.generateStruct(decl);
      } else if (decl.kind === 'enum') {
        this.generateEnum(decl);
      }
    }

    // Then statements
    for (const stmt of program.statements) {
      if (stmt.kind === 'import') {
        this.generateImport(stmt);
      } else {
        this.generateStmt(stmt);
      }
    }

    return this.output.join('\n');
  }

  private line(text = ''): void {
    this.output.push('  '.repeat(this.indent) + text);
  }

  private generateFunction(fn: FunctionDecl): void {
    const params = fn.params.map(p => p.name).join(', ');
    
    if (fn.body.statements.length === 0 && fn.returnType) {
      this.line(`function ${fn.name}(${params}) {`);
      this.indent++;
      this.line('return undefined;');
      this.indent--;
      this.line('}');
      return;
    }

    this.line(`function ${fn.name}(${params}) {`);
    this.indent++;
    this.generateBlock(fn.body);
    this.indent--;
    this.line('}');
    this.line();
  }

  private generateStruct(struct: StructDecl): void {
    const fields = struct.fields.map(f => f.name).join(', ');
    
    this.line(`// ${struct.name} struct`);
    this.line(`function ${struct.name}(${fields}) {`);
    this.indent++;
    this.line(`return { ${fields} };`);
    this.indent--;
    this.line('}');
    this.line();
  }

  private generateEnum(enumDecl: EnumDecl): void {
    this.line(`// ${enumDecl.name} enum`);
    
    for (const variant of enumDecl.variants) {
      const variantName = `${enumDecl.name}_${variant.name}`;
      const fieldCount = variant.fields?.length ?? 0;
      
      if (fieldCount === 0) {
        this.line(`const ${variantName} = { tag: "${variant.name}" };`);
      } else {
        const params = variant.fields!.map((_, i) => `value${i}`).join(', ');
        
        if (fieldCount === 1) {
          this.line(`function ${variantName}(value) { return { tag: "${variant.name}", value }; }`);
        } else {
          this.line(`function ${variantName}(${params}) { return { tag: "${variant.name}", values: [${params}] }; }`);
        }
      }
    }
    this.line();
  }

  private generateImport(imp: ImportStmt): void {
    const names = imp.names.join(', ');
    this.line(`import { ${names} } from "${imp.from}";`);
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
      case 'block':
        this.generateBlock(stmt);
        break;
      case 'expr':
        this.line(`${this.generateExpr(stmt.expr)};`);
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

  private generateIf(ifStmt: IfStmtType): void {
    this.line(`if (${this.generateExpr(ifStmt.cond)}) {`);
    this.indent++;
    this.generateBlock(ifStmt.thenBranch);
    this.indent--;
    
    if (ifStmt.elseBranch) {
      if (ifStmt.elseBranch.kind === 'if') {
        this.line(`} else `);
        const elseIf = ifStmt.elseBranch;
        this.line(`if (${this.generateExpr(elseIf.cond)}) {`);
        this.indent++;
        this.generateBlock(elseIf.thenBranch);
        this.indent--;
        
        if (elseIf.elseBranch) {
          this.line(`} else {`);
          this.indent++;
          this.generateBlockOrIf(elseIf.elseBranch);
          this.indent--;
          this.line('}');
        } else {
          this.line('}');
        }
      } else {
        this.line('} else {');
        this.indent++;
        this.generateBlockOrIf(ifStmt.elseBranch);
        this.indent--;
        this.line('}');
      }
    } else {
      this.line('}');
    }
  }

  private generateBlockOrIf(blockOrIf: Block | IfStmtType): void {
    if (blockOrIf.kind === 'block') {
      this.generateBlock(blockOrIf);
    } else {
      this.generateIf(blockOrIf);
    }
  }

  private generateWhile(whileStmt: WhileStmtType): void {
    this.line(`while (${this.generateExpr(whileStmt.cond)}) {`);
    this.indent++;
    this.generateBlock(whileStmt.body);
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
        return expr.name;

      case 'binary':
        const left = this.generateExpr(expr.left);
        const right = this.generateExpr(expr.right);
        return `(${left} ${expr.op} ${right})`;

      case 'unary':
        const operand = this.generateExpr(expr.operand);
        return `(${expr.op}${operand})`;

      case 'call':
        const callee = this.generateExpr(expr.callee);
        const args = expr.args.map(a => this.generateExpr(a)).join(', ');
        return `${callee}(${args})`;

      case 'member':
        const obj = this.generateExpr(expr.object);
        return `${obj}.${expr.property}`;

      case 'postfix':
        return this.generatePostfix(expr);

      case 'object':
        const fields = expr.fields.map(f => `${f.name}: ${this.generateExpr(f.value)}`).join(', ');
        return `{ ${fields} }`;

      case 'array':
        const elements = expr.elements.map(e => this.generateExpr(e)).join(', ');
        return `[${elements}]`;

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
    const tempVar = `__match_val`;
    const arms = matchExpr.arms.map((arm, index) => {
      const condition = this.generatePatternCondition(tempVar, arm.pattern);
      const guard = arm.guard ? ` && (${this.generateExpr(arm.guard)})` : '';
      const blockCode = this.generateBlockToValue(arm.body);
      const elseClause = index === matchExpr.arms.length - 1 ? '' : 'else ';
      return `${elseClause}if (${condition}${guard}) {\n${blockCode}\n}`;
    }).join(' ');

    return `(() => {\n  const ${tempVar} = ${this.generateExpr(matchExpr.expr)};\n  ${arms}\n})();`;
  }

  private generatePatternCondition(tempVar: string, pattern: Pattern): string {
    switch (pattern.kind) {
      case 'wildcard':
        return 'true';

      case 'literal':
        const litVal = typeof pattern.value === 'string' 
          ? JSON.stringify(pattern.value) 
          : String(pattern.value);
        return `${tempVar} === ${litVal}`;

      case 'identifier':
        return 'true';

      case 'enum_variant':
        return `${tempVar}.tag === "${pattern.name}"`;

      case 'struct_pattern':
        const conditions = pattern.fields.map(f => 
          `${tempVar}.${f.name} === ${f.bind}`
        ).join(' && ');
        return conditions || 'true';
    }
  }

  private generateBlockToValue(block: Block): string {
    const lastStmt = block.statements[block.statements.length - 1];
    if (lastStmt?.kind === 'return' && lastStmt.value) {
      const prefix = block.statements.slice(0, -1).map(s => {
        this.indent++;
        const code = this.generateStmtToString(s);
        this.indent--;
        return code;
      }).join('\n');
      
      const returnValue = this.generateExpr(lastStmt.value);
      return prefix ? `${prefix}\n  return ${returnValue};` : `  return ${returnValue};`;
    }
    
    return block.statements.map(s => {
      this.indent++;
      const code = this.generateStmtToString(s);
      this.indent--;
      return code;
    }).join('\n');
  }

  private generateStmtToString(stmt: Stmt): string {
    const gen = new CodeGenerator();
    gen.indent = this.indent;
    gen.generateStmt(stmt);
    return gen.output.join('\n');
  }
}

export function generate(program: Program): string {
  const generator = new CodeGenerator();
  return generator.generate(program);
}
