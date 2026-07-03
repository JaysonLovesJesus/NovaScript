# NovaScript

> **NovaScript** is a modern, safe language that compiles to readable JavaScript.  
> It removes the historical footguns of JavaScript (null, undefined, exceptions-as-control-flow, any) and adds sound types, exhaustive pattern matching, compile‑time execution, and clean interop with the JS ecosystem.

---

## 1. Lexical Structure

### 1.1 Keywords
Reserved words, cannot be used as identifiers:

```
fn let mut match if else for while return
type struct enum pub import from unsafe comptime
as in true false self Some None Ok Err
```

(Note: `Option` and `Result` are standard library types, not keywords. `Some`, `None`, `Ok`, `Err` are reserved variant constructors.)

### 1.2 Operators and Punctuation

```
+  -  *  /  %  =  ==  !=  <  >  <=  >=
!  && || .  .. ?  ?. => (  )  [  ]  {  }
,  ;  :  _  @
```

- `.try` and `.await` are reserved postfix keywords (not identifiers).
- `..` is the range operator.
- `?.` is the optional chaining operator (on `Option`).
- `?` is the postfix `Option` unwrap operator.
- `=>` separates patterns from bodies in `match` arms.

### 1.3 Literals
- **Numbers**: decimal with optional underscores: `42`, `3.14`, `1_000_000`. (Compiles to JS numbers.)
- **Strings**: `"hello"`, `'hello'`, and `` `Hello, ${name}` `` for interpolation (compiles to JS template literals).
- **Booleans**: `true`, `false`.

### 1.4 Identifiers
Start with a letter or underscore, followed by letters, digits, or underscores.  
Convention: types (`struct`, `enum`) use `PascalCase`; variables and functions use `camelCase`.

---

## 2. Types

### 2.1 Structural Type Aliases (`type`)
A `type` alias gives a name to a structural shape. Two values with matching shapes are compatible, irrespective of the alias.

```rs
type Vec2 = {
    x: num,
    y: num,
    plus(other: Vec2): Vec2,
}
```

### 2.2 Nominal Structs (`struct`)
A `struct` defines a new, distinct type. Two structs with identical fields are different types and not implicitly convertible.

```rs
struct Position {
    pos: Vec2,
}
```

`pub` marks declarations (fn, struct, enum, methods) as exported; it does not apply to individual fields — a struct's fields are always accessible wherever the struct itself is.

### 2.3 Nominal Enums (Algebraic Data Types)
An `enum` defines a tagged union. Each variant can hold zero or more typed payloads.

```rs
enum Option<T> { Some(T), None }
enum Result<V, E> { Ok(V), Err(E) }
```

Enums are nominal: identical shapes from different enum definitions are distinct types.

### 2.4 Generics
Functions, structs, and enums can have type parameters in angle brackets.

```rs
fn identity<T>(value: T): T { value }
struct Pair<A, B> { first: A, second: B }
```

Type parameters can be inferred at call sites or provided explicitly.

### 2.5 Built‑in Types
- `num` – 64‑bit floating point (JS `number`).
- `string` – UTF‑16 string (JS `string`).
- `bool` – `true` or `false`.
- `void` – no value (return type only).
- `Promise<T>` – an asynchronous operation, mirroring JS promises.
- `Option<T>` and `Result<V,E>` are standard library enums (not language built‑ins).

### 2.6 Function Types
`(ParamType, ...): ReturnType`, e.g. `(num, num): num` or `(str): bool`. Used to type callback parameters and fields:

```
fn apply(f: (num): num, x: num): num { f(x) }
```

---

## 3. Expressions

### 3.1 Primaries
- Literals, identifiers, `self` (in methods), `Some(...)`, `None`, `Ok(...)`, `Err(...)`.
- Constructor expressions: `StructName { field: value, ... }`.
- Enum variant payloads: `Some(5)`, `Err("fail")`.
- Parenthesised expressions.

### 3.1a Closures
Anonymous functions with lexical capture:

- Single bare parameter: `fn x => x + 1`
- Parenthesised (zero or more, optional types): `fn (a, b) => a + b`, `fn (x: num) => x * 2`
- Block body (last expression is the result): `fn v => { let lo = max(0, v); min(255, lo) }`

A closure is its own function scope: `.try`/`?` return from the *closure*, and `.await` makes only that closure async. Closures compile to plain JS arrow functions. When passed to a `(T): R`-typed parameter, their parameter and return types are inferred from that signature.

```
let inc     = fn x => x + 1;
let add     = fn (a, b) => a + b;
let doubled = twice_each(fn n => n * 2, xs);
```

### 3.2 Operators (in order of precedence)
1. `.` (method call, field access, postfix keywords `.try`, `.await`, `.catch`, `.unwrap`, `?.`, `?`)
2. `!`, `-` (unary)
3. `*`, `/`, `%`
4. `+`, `-`
5. `..` (range)
6. `==`, `!=`, `<`, `>`, `<=`, `>=`
7. `&&`
8. `||`
9. `?` (postfix `Option` unwrap, same precedence as `.try`)

### 3.3 Operator Overloading
Operators desugar to method calls on the left operand:

| Operator | Method     |
|----------|------------|
| `a + b`  | `a.plus(b)`  |
| `a - b`  | `a.minus(b)` |
| `a * b`  | `a.times(b)` |
| `a / b`  | `a.div(b)`   |
| `-a`     | `a.neg()`    |
| `a == b` | `a.equals(b)` (fallback to strict equality if no method) |

Compile‑time error if the method does not exist on the type.

### 3.4 Uniform Function Call Syntax (UFCS)
If `value.func(args)` cannot be resolved as a struct method, the compiler looks for a module‑level function `func(value, args...)`. If found, the call is rewritten accordingly. This enables fluent chaining of free functions:

```rs
v.normalize().scale(2)
// equivalent to scale(normalize(v), 2)
```

### 3.5 Postfix Keywords
- **`.await`** – on `Promise<T>`, yields `T` (only valid inside `async` functions).
- **`.try`** – on `Result<T,E>`, unwraps `Ok(v)` to `v`; on `Err(e)`, immediately returns `Err(e)` from the enclosing function.
- **`.catch(handler)`** – on `Result<T,E>`: if `Err`, calls `handler(err)` (which may return a fallback value).
- **`.unwrap()`** – on `Option<T>` or `Result<T,E>`: panics (throws JS error) if `None`/`Err`.
- **`.unwrap_or(default)`** – on `Option<T>`: returns the contained value or `default`.

### 3.6 Optional Chaining on `Option`
- `opt?.field` – if `opt` is `None`, returns `None`; if `Some(x)`, returns `Some(x.field)`.
- `opt?` – postfix `Option` unwrap: returns the contained value or immediately returns `None` from the function.

### 3.7 Match Expression
`match` is a primary expression (see Section 5). It evaluates to a value.

### 3.8 Unsafe Blocks
`unsafe { ... }` encloses raw JavaScript code. The compiler trusts the result type, no static checks inside. Can only appear where the surrounding type expects a value of some `T`.

### 3.9 Comptime Calls
Calls to `comptime` functions are evaluated at compile time. The arguments must be known at build time.

---

## 4. Statements

### 4.1 Variable Binding
- `let name = expr;` – immutable binding, type inferred or explicit.
- `let mut name = expr;` – mutable binding.

### 4.2 Assignment
`name = expr;` (only for `mut` bindings).

### 4.3 Control Flow
- `if cond { ... } else { ... }` – expression/statement.
- `while cond { ... }` – loop.
- `for item in iterable { ... }` – iterates over an `Iterable` structural type (or a range).
- `return expr;` – early exit.

### 4.4 Range Loop
`start..end` creates a `Range` literal. In a `for` loop, the compiler desugars a literal integer range to a standard JS `for` loop for efficiency. For non‑literal ranges, the iteration protocol (structural `iter`/`next`) is used.

### 4.5 Unsafe Statement
`unsafe { ... }` where `...` is raw JS code; used for interop without return value.

---

## 5. Pattern Matching

### 5.1 Match Expression Syntax
```rs
match subject {
    pattern => expression,
    pattern if guard => expression,
    _ => default_expression
}
```
- Patterns are tested in order. The first matching arm is evaluated.
- The compiler checks **exhaustiveness** and reports an error if a case is missing.
- `_` is a wildcard; `x` binds a variable; `Some(x)` destructures; `None` matches literals; `(a, b)` matches tuples.
- Guards: `pattern if condition => ...`; the arm only matches if the guard evaluates to `true`.
- OR patterns: `pattern1 | pattern2` matches if either sub‑pattern matches (only allowed with simple bindings, no payload duplication).

### 5.2 Destructuring
- Structs: `Position { pos: v }` binds `v` to the `pos` field.
- Enums: `Some(inner)` binds `inner`.
- Tuples: `(a, b)`.

---

## 6. Modules & Visibility

### 6.1 File Modules
Every `.nova` file is a module. File name corresponds to module name.

### 6.2 Exports
Use `pub` to mark declarations as exported:
```rs
pub fn add(a: num, b: num): num { a + b }
pub struct Vec2 { ... }
```

### 6.3 Imports
- `import { name1, name2 } from "./path"` – imports specific public bindings.
- `import * as ns from "./path"` – namespace import.
- `import unsafe { jsName as localName } from "npm-package"` – imports a raw JS binding, only usable inside `unsafe` blocks.

Imports are resolved relative to the current file.

---

## 7. Unsafe Interop

- `unsafe` blocks contain raw JavaScript and are the only place where JS‑specific APIs (DOM, Node, third‑party libraries) can be called.
- Inside `unsafe`, `null`, `undefined`, and exceptions are allowed. The compiler trusts the programmer to handle them.
- Values returned from `unsafe` blocks are implicitly cast to the expected type (no explicit coercion required).
- `import unsafe { ... }` binds JS modules as raw identifiers that can only be referenced inside `unsafe`.

---

## 8. Comptime (Compile‑time Execution)

### 8.1 Comptime Functions
```rs
comptime fn name(params): ReturnType { ... }
```
- Called only with compile‑time‑known arguments.
- The body can contain any code that only uses comptime‑available operations (arithmetic, logic, loops, basic data structures). No `unsafe`, no async, no external state.
- The function evaporates; its result is embedded directly in the generated JS.

### 8.2 Comptime Blocks
```rs
let constant = comptime { /* code */ };
```
The block is evaluated at build time, and the final expression becomes the constant value.

### 8.3 Use Cases
- Pre‑computing lookup tables, hashing, validation.
- Generating repetitive code (e.g., query iterator functions).
- Lightweight metaprogramming without macros.

---

## 9. Async Model

- `async` functions are not specially marked; instead, any function that uses `.await` is implicitly async. (The compiler detects this and marks the generated function as `async`.)
- Top‑level `await` is allowed; the output is an ES module.
- `Promise<T>` is the standard async return type; `.await` unwraps `T` from a `Promise<T>`.

---

## 10. Built‑In Features (No Runtime Library)

NovaScript does not ship with a traditional standard library. Instead, the following features are provided by the **compiler** as language intrinsics, generating pure JavaScript with no external dependencies.

### 10.1 `Option<T>` and `Result<V,E>`
These are declared using `enum` in the user’s code or via a prelude (see 10.6). The compiler knows their internal representation (tagged objects) and optimizes pattern matching on them. No library code is injected.

### 10.2 Iteration Protocol
Any object with a structural `iter()` method returning an object with `next() -> Option<T>` is considered `Iterable<T>`. The `for item in iterable` loop compiles directly to a `for…of` loop using the iteration protocol, calling `.iter().next()` in a standard way. No library helper is required.

### 10.3 Range Literals (`start..end`)
In a `for` loop, a literal integer range `0..10` is desugared directly into a classic JavaScript `for` loop (`for (let i = 0; i < 10; i++)`). For non‑literal ranges, the compiler creates an object satisfying the `Iterable<num>` interface inline—no library object needed.

### 10.4 Built‑in Functions (Math, Printing)
The following functions are always available (implicitly imported) and compile directly to JavaScript:

| NovaScript function | JavaScript equivalent |
|---------------------|-----------------------|
| `sqrt(x)`           | `Math.sqrt(x)`        |
| `abs(x)`            | `Math.abs(x)`         |
| `ceil(x)`           | `Math.ceil(x)`        |
| `floor(x)`          | `Math.floor(x)`       |
| `round(x)`          | `Math.round(x)`       |
| `max(a,b)`          | `Math.max(a,b)`       |
| `min(a,b)`          | `Math.min(a,b)`       |
| `print(x)`          | `console.log(x)`      |
| `panic(msg)`        | `throw new Error(msg)`|

*(More may be added later, but only those with direct JS counterparts and zero runtime cost.)*

Users can also call `unsafe { console.log(...) }` for more complex logging.

### 10.5 `Promise<T>`
`Promise<T>` is a type alias for the built‑in JavaScript `Promise`. The `.await` postfix unwraps it via `await`, with no wrapper. No runtime library.

### 10.6 Implicit Prelude (Optional)
To avoid requiring explicit `enum` definitions in every file, the compiler may optionally inject a “prelude” that defines `Option<T>` and `Result<V,E>` as nominal enums (identical to what a user would write). This injection happens at compile time and produces the same tagged‑object representation, adding zero bytes to the user’s code. A compiler flag (`--no-prelude`) can disable this if the user wishes to provide their own.

---

## 11. Compiler Output & Tooling

### 11.1 Compilation
The compiler translates NovaScript source files to clean, idiomatic JavaScript (ES modules). The output:
- Uses `export`/`import` for module boundaries.
- Represents enums as tagged objects: `{ tag: "VariantName", value: payload }`.
- Represents structs as classes or plain constructors.
- Inlines comptime results.
- Preserves variable names and control flow structure for readability.

### 11.2 TypeScript Declaration Files (`.d.ts`)
The compiler can emit `.d.ts` files, mapping NovaScript’s nominal and structural types to TypeScript interfaces and type aliases, enabling seamless consumption from TypeScript codebases.

### 11.3 Diagnostics
Lex, parse, and type errors are reported as `rustc`-style code frames with a caret under the offending token:

```
error: t argument 1: expected num, got str
  ─> playground.nova:1:39
  │
1 │ fn t(n: num): num { n } fn main() { t("x"); }
  │                                       ^
```

### 11.4 Formatter
`novascript fmt <file.nova>...` rewrites source into a canonical, opinionated style: 4‑space indentation, normalized spacing and type aliases, brace‑form match arms, `//` comments preserved. Add `--check` to fail (non‑zero exit) instead of writing, for CI. The formatter is idempotent and semantics‑preserving.

### 11.5 Playground
A static, dependency‑free web playground lives in `playground/`. Build the browser bundle and serve it:

```
npm run build:playground          # bundles the compiler to playground/dist/
python3 -m http.server -d playground 4173
```

It compiles NovaScript to JS in the browser, runs it live (capturing `console.log`), formats source, and shows the generated JavaScript — all client‑side, no server.

### 11.6 Language Server
A NovaScript LSP server (planned) will provide autocompletion, diagnostics, go‑to‑definition, and hover types, based on the same type checker used by the compiler.

---

## 12. Design Tenets
- **Modern JavaScript without the historical baggage.**
- **Safety by default**: no `null`/`undefined`, exhaustive matching, immutable bindings by default.
- **Uncomplicated interop**: raw JS only inside `unsafe`; otherwise, the safe world remains sound.
- **Compile‑time magic**: comptime for precomputation and metaprogramming, keeping the runtime lean.
- **Clean code generation**: the output should look like what a human would write.
