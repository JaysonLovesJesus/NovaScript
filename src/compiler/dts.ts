// TypeScript declaration (.d.ts) emitter.
//
// Walks a module's public API (pub structs, enums, functions) and produces
// matching TypeScript declarations so NovaScript output can be consumed from
// typed JS/TS. Types are mapped structurally; Option/Result expand to the same
// tagged-union shape the codegen emits at runtime.

import type {
  Program, TypeAnnotation, FunctionDecl, StructDecl, EnumDecl,
} from './ast.js';

function tsType(ann: TypeAnnotation | undefined): string {
  if (!ann) return 'unknown';
  switch (ann.kind) {
    case 'num': return 'number';
    case 'str': return 'string';
    case 'bool': return 'boolean';
    case 'void': return 'void';
    case 'generic': return ann.name;
    case 'array': return `${tsType(ann.element)}[]`;
    case 'function': {
      const params = ann.params.map((p, i) => `arg${i}: ${tsType(p)}`).join(', ');
      return `(${params}) => ${tsType(ann.ret)}`;
    }
    case 'option':
      return `({ tag: "Some"; value: ${tsType(ann.inner)} } | { tag: "None" })`;
    case 'result':
      return `({ tag: "Ok"; value: ${tsType(ann.ok)} } | { tag: "Err"; value: ${tsType(ann.err)} })`;
    case 'nominal': {
      if (ann.name === 'Promise') return `Promise<${tsType(ann.typeArgs?.[0])}>`;
      const args = ann.typeArgs?.length ? `<${ann.typeArgs.map(tsType).join(', ')}>` : '';
      return `${ann.name}${args}`;
    }
  }
}

function typeParamList(params?: string[]): string {
  return params?.length ? `<${params.join(', ')}>` : '';
}

function fnReturn(fn: FunctionDecl): string {
  const ret = tsType(fn.returnType);
  // An async fn already annotated Promise<...> keeps it; otherwise wrap
  if (fn.isAsync && !(fn.returnType?.kind === 'nominal' && fn.returnType.name === 'Promise')) {
    return `Promise<${ret}>`;
  }
  return ret;
}

function fnSignature(fn: FunctionDecl): string {
  const params = fn.params.map(p => `${p.name}: ${tsType(p.type)}`).join(', ');
  return `${fn.name}${typeParamList(fn.typeParams)}(${params}): ${fnReturn(fn)}`;
}

function emitStruct(struct: StructDecl): string {
  const tp = typeParamList(struct.typeParams);
  const lines = [`export interface ${struct.name}${tp} {`];
  for (const field of struct.fields) {
    lines.push(`  ${field.name}: ${tsType(field.type)};`);
  }
  for (const method of struct.methods) {
    lines.push(`  ${fnSignature(method)};`);
  }
  lines.push('}');
  // The runtime constructor shares the type's name (declaration merging)
  const ctorParams = struct.fields.map(f => `${f.name}: ${tsType(f.type)}`).join(', ');
  lines.push(`export declare function ${struct.name}${tp}(${ctorParams}): ${struct.name}${tp};`);
  return lines.join('\n');
}

function emitEnum(decl: EnumDecl): string {
  const tp = typeParamList(decl.typeParams);
  const members = decl.variants.map(v => {
    const count = v.fields?.length ?? 0;
    if (count === 0) return `{ tag: "${v.name}" }`;
    if (count === 1) return `{ tag: "${v.name}"; value: ${tsType(v.fields![0])} }`;
    const tuple = v.fields!.map(tsType).join(', ');
    return `{ tag: "${v.name}"; values: [${tuple}] }`;
  });
  const lines = [`export type ${decl.name}${tp} =`];
  members.forEach((m, i) => {
    lines.push(`  | ${m}${i === members.length - 1 ? ';' : ''}`);
  });
  // Variant constructors, matching codegen's Enum_Variant naming
  for (const v of decl.variants) {
    const count = v.fields?.length ?? 0;
    const ret = `${decl.name}${tp}`;
    if (count === 0) {
      lines.push(`export declare const ${decl.name}_${v.name}: ${ret};`);
    } else if (count === 1) {
      lines.push(`export declare function ${decl.name}_${v.name}${tp}(value: ${tsType(v.fields![0])}): ${ret};`);
    } else {
      const params = v.fields!.map((f, i) => `value${i}: ${tsType(f)}`).join(', ');
      lines.push(`export declare function ${decl.name}_${v.name}${tp}(${params}): ${ret};`);
    }
  }
  return lines.join('\n');
}

function esmPath(from: string): string {
  if (!from.startsWith('.')) return from;
  return from.replace(/\.nova$/, '') + '.js';
}

export function emitDts(program: Program): string {
  const blocks: string[] = [];

  // Imports (and re-exports, mirroring the JS) so referenced type names resolve
  for (const stmt of program.statements) {
    if (stmt.kind !== 'import' || stmt.isUnsafe) continue;
    const names = stmt.names.join(', ');
    const from = esmPath(stmt.from);
    blocks.push(`import { ${names} } from "${from}";\nexport { ${names} } from "${from}";`);
  }

  for (const decl of program.declarations) {
    if (!decl.isPub) continue;
    if (decl.kind === 'function') {
      if (decl.isComptime) continue;
      blocks.push(`export declare function ${fnSignature(decl)};`);
    } else if (decl.kind === 'struct') {
      blocks.push(emitStruct(decl));
    } else if (decl.kind === 'enum') {
      blocks.push(emitEnum(decl));
    }
  }
  return blocks.join('\n\n') + (blocks.length ? '\n' : '');
}
