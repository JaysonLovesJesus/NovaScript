// Semantic types for the NovaScript checker.
// Distinct from ast.TypeAnnotation, which is purely syntactic.

export type Type =
  | { kind: 'num' }
  | { kind: 'str' }
  | { kind: 'bool' }
  | { kind: 'void' }
  | { kind: 'unknown' }
  | { kind: 'array'; element: Type }
  | { kind: 'tuple'; elements: Type[] }
  | { kind: 'struct'; name: string }
  | { kind: 'enum'; name: string; typeArgs: Type[] }
  | { kind: 'fn'; params: Type[]; ret: Type; isAsync?: boolean }
  | { kind: 'promise'; inner: Type }
  | { kind: 'typevar'; name: string };

export const NUM: Type = { kind: 'num' };
export const STR: Type = { kind: 'str' };
export const BOOL: Type = { kind: 'bool' };
export const VOID: Type = { kind: 'void' };
export const UNKNOWN: Type = { kind: 'unknown' };

export function optionOf(inner: Type): Type {
  return { kind: 'enum', name: 'Option', typeArgs: [inner] };
}

export function resultOf(ok: Type, err: Type): Type {
  return { kind: 'enum', name: 'Result', typeArgs: [ok, err] };
}

export function typeToString(t: Type): string {
  switch (t.kind) {
    case 'num': case 'str': case 'bool': case 'void': case 'unknown':
      return t.kind;
    case 'array': return `${typeToString(t.element)}[]`;
    case 'tuple': return `(${t.elements.map(typeToString).join(', ')})`;
    case 'struct': return t.name;
    case 'enum':
      return t.typeArgs.length
        ? `${t.name}<${t.typeArgs.map(typeToString).join(', ')}>`
        : t.name;
    case 'fn': return `fn(${t.params.map(typeToString).join(', ')}): ${typeToString(t.ret)}`;
    case 'promise': return `Promise<${typeToString(t.inner)}>`;
    case 'typevar': return t.name;
  }
}

export type Substitution = Map<string, Type>;

export function substitute(t: Type, subst: Substitution): Type {
  switch (t.kind) {
    case 'typevar':
      return subst.get(t.name) ?? t;
    case 'array':
      return { kind: 'array', element: substitute(t.element, subst) };
    case 'tuple':
      return { kind: 'tuple', elements: t.elements.map(e => substitute(e, subst)) };
    case 'enum':
      return { kind: 'enum', name: t.name, typeArgs: t.typeArgs.map(a => substitute(a, subst)) };
    case 'fn':
      return {
        kind: 'fn',
        params: t.params.map(p => substitute(p, subst)),
        ret: substitute(t.ret, subst),
        isAsync: t.isAsync,
      };
    case 'promise':
      return { kind: 'promise', inner: substitute(t.inner, subst) };
    default:
      return t;
  }
}

// Structural unification. Free typevars in `expected` are bound in `subst`.
// `unknown` unifies with anything (interop escape hatch).
export function unify(expected: Type, actual: Type, subst: Substitution): boolean {
  if (expected.kind === 'unknown' || actual.kind === 'unknown') return true;

  if (expected.kind === 'typevar') {
    const bound = subst.get(expected.name);
    if (bound) return unify(bound, actual, subst);
    subst.set(expected.name, actual);
    return true;
  }
  if (actual.kind === 'typevar') {
    // a generic parameter used inside its own fn body only matches itself,
    // and identical typevars were already handled above
    return false;
  }

  switch (expected.kind) {
    case 'num': case 'str': case 'bool': case 'void':
      return actual.kind === expected.kind;
    case 'array':
      return actual.kind === 'array' && unify(expected.element, actual.element, subst);
    case 'tuple':
      return actual.kind === 'tuple'
        && actual.elements.length === expected.elements.length
        && expected.elements.every((e, i) => unify(e, actual.elements[i], subst));
    case 'struct':
      return actual.kind === 'struct' && actual.name === expected.name;
    case 'enum':
      return actual.kind === 'enum'
        && actual.name === expected.name
        && expected.typeArgs.length === actual.typeArgs.length
        && expected.typeArgs.every((a, i) => unify(a, actual.typeArgs[i], subst));
    case 'fn':
      return actual.kind === 'fn'
        && actual.params.length === expected.params.length
        && expected.params.every((p, i) => unify(p, actual.params[i], subst))
        && unify(expected.ret, actual.ret, subst);
    case 'promise':
      return actual.kind === 'promise' && unify(expected.inner, actual.inner, subst);
  }
  return false;
}

export function typesCompatible(a: Type, b: Type): boolean {
  return unify(a, b, new Map());
}
