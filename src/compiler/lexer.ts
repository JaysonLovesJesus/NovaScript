// Lexer for NovaScript

export interface Token {
  type: TokenType;
  value: string;
  line: number;
  column: number;
}

export enum TokenType {
  // Literals
  NUMBER = 'NUMBER',
  STRING = 'STRING',
  TRUE = 'TRUE',
  FALSE = 'FALSE',
  
  // Keywords
  LET = 'LET',
  MUT = 'MUT',
  FN = 'FN',
  PUB = 'PUB',
  STRUCT = 'STRUCT',
  ENUM = 'ENUM',
  MATCH = 'MATCH',
  IF = 'IF',
  ELSE = 'ELSE',
  WHILE = 'WHILE',
  RETURN = 'RETURN',
  COMPTIME = 'COMPTIME',
  UNSAFE = 'UNSAFE',
  IMPORT = 'IMPORT',
  FROM = 'FROM',
  
  // Types
  NUM = 'NUM',
  STR = 'STR',
  BOOL = 'BOOL',
  VOID = 'VOID',
  OPTION = 'OPTION',
  RESULT = 'RESULT',
  
  // Identifiers and operators
  IDENT = 'IDENT',
  PLUS = 'PLUS',
  MINUS = 'MINUS',
  STAR = 'STAR',
  SLASH = 'SLASH',
  PERCENT = 'PERCENT',
  EQ = 'EQ',
  EQEQ = 'EQEQ',
  NEQ = 'NEQ',
  LT = 'LT',
  GT = 'GT',
  LTE = 'LTE',
  GTE = 'GTE',
  AND = 'AND',
  OR = 'OR',
  NOT = 'NOT',
  QUESTION = 'QUESTION',
  DOT = 'DOT',
  COMMA = 'COMMA',
  COLON = 'COLON',
  SEMICOLON = 'SEMICOLON',
  LPAREN = 'LPAREN',
  RPAREN = 'RPAREN',
  LBRACE = 'LBRACE',
  RBRACE = 'RBRACE',
  LBRACKET = 'LBRACKET',
  RBRACKET = 'RBRACKET',
  ARROW = 'ARROW',
  FAT_ARROW = 'FAT_ARROW',
  
  // Postfix operators
  DOT_AWAIT = 'DOT_AWAIT',
  DOT_TRY = 'DOT_TRY',
  DOT_CATCH = 'DOT_CATCH',
  DOT_UNWRAP = 'DOT_UNWRAP',
  DOT_UNWRAP_OR = 'DOT_UNWRAP_OR',
  
  EOF = 'EOF',
  ERROR = 'ERROR',
}

const KEYWORDS: Record<string, TokenType> = {
  'let': TokenType.LET,
  'mut': TokenType.MUT,
  'fn': TokenType.FN,
  'pub': TokenType.PUB,
  'struct': TokenType.STRUCT,
  'enum': TokenType.ENUM,
  'match': TokenType.MATCH,
  'if': TokenType.IF,
  'else': TokenType.ELSE,
  'while': TokenType.WHILE,
  'return': TokenType.RETURN,
  'comptime': TokenType.COMPTIME,
  'unsafe': TokenType.UNSAFE,
  'import': TokenType.IMPORT,
  'from': TokenType.FROM,
  'num': TokenType.NUM,
  'str': TokenType.STR,
  'bool': TokenType.BOOL,
  'void': TokenType.VOID,
  'Option': TokenType.OPTION,
  'Result': TokenType.RESULT,
  'true': TokenType.TRUE,
  'false': TokenType.FALSE,
};

export class LexerError extends Error {
  constructor(message: string, public line: number, public column: number) {
    super(`[${line}:${column}] ${message}`);
  }
}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let column = 1;
  
  while (pos < source.length) {
    const startLine = line;
    const startColumn = column;
    const char = source[pos];
    
    // Whitespace
    if (char === ' ' || char === '\t') {
      pos++;
      column++;
      continue;
    }
    
    if (char === '\n') {
      pos++;
      line++;
      column = 1;
      continue;
    }
    
    // Comments
    if (char === '/' && source[pos + 1] === '/') {
      while (pos < source.length && source[pos] !== '\n') {
        pos++;
        column++;
      }
      continue;
    }
    
    // String literals
    if (char === '"' || char === "'") {
      const quote = char;
      let value = '';
      pos++;
      column++;
      
      while (pos < source.length && source[pos] !== quote) {
        if (source[pos] === '\\') {
          pos++;
          column++;
          if (pos >= source.length) {
            throw new LexerError('Unterminated string', startLine, startColumn);
          }
          const escaped = source[pos];
          switch (escaped) {
            case 'n': value += '\n'; break;
            case 't': value += '\t'; break;
            case 'r': value += '\r'; break;
            case '\\': value += '\\'; break;
            case quote: value += quote; break;
            default: value += escaped;
          }
        } else {
          value += source[pos];
        }
        pos++;
        column++;
      }
      
      if (pos >= source.length) {
        throw new LexerError('Unterminated string', startLine, startColumn);
      }
      
      pos++; // closing quote
      column++;
      tokens.push({ type: TokenType.STRING, value, line: startLine, column: startColumn });
      continue;
    }
    
    // Numbers (with underscore support)
    if (/\d/.test(char)) {
      let value = '';
      while (pos < source.length && /[\d_]/.test(source[pos])) {
        if (source[pos] !== '_') {
          value += source[pos];
        }
        pos++;
        column++;
      }
      
      // Handle decimals
      if (source[pos] === '.' && /\d/.test(source[pos + 1])) {
        value += '.';
        pos++;
        column++;
        while (pos < source.length && /[\d_]/.test(source[pos])) {
          if (source[pos] !== '_') {
            value += source[pos];
          }
          pos++;
          column++;
        }
      }
      
      tokens.push({ type: TokenType.NUMBER, value, line: startLine, column: startColumn });
      continue;
    }
    
    // Identifiers and keywords
    if (/[a-zA-Z_$]/.test(char)) {
      let value = '';
      while (pos < source.length && /[a-zA-Z0-9_$]/.test(source[pos])) {
        value += source[pos];
        pos++;
        column++;
      }
      
      const type = KEYWORDS[value] || TokenType.IDENT;
      tokens.push({ type, value, line: startLine, column: startColumn });
      continue;
    }
    
    // Two-character operators
    if (char === '=' && source[pos + 1] === '=') {
      tokens.push({ type: TokenType.EQEQ, value: '==', line: startLine, column: startColumn });
      pos += 2;
      column += 2;
      continue;
    }
    
    if (char === '!' && source[pos + 1] === '=') {
      tokens.push({ type: TokenType.NEQ, value: '!=', line: startLine, column: startColumn });
      pos += 2;
      column += 2;
      continue;
    }
    
    if (char === '<' && source[pos + 1] === '=') {
      tokens.push({ type: TokenType.LTE, value: '<=', line: startLine, column: startColumn });
      pos += 2;
      column += 2;
      continue;
    }
    
    if (char === '>' && source[pos + 1] === '=') {
      tokens.push({ type: TokenType.GTE, value: '>=', line: startLine, column: startColumn });
      pos += 2;
      column += 2;
      continue;
    }
    
    if (char === '&' && source[pos + 1] === '&') {
      tokens.push({ type: TokenType.AND, value: '&&', line: startLine, column: startColumn });
      pos += 2;
      column += 2;
      continue;
    }
    
    if (char === '|' && source[pos + 1] === '|') {
      tokens.push({ type: TokenType.OR, value: '||', line: startLine, column: startColumn });
      pos += 2;
      column += 2;
      continue;
    }
    
    if (char === '-' && source[pos + 1] === '>') {
      tokens.push({ type: TokenType.ARROW, value: '->', line: startLine, column: startColumn });
      pos += 2;
      column += 2;
      continue;
    }
    
    if (char === '=' && source[pos + 1] === '>') {
      tokens.push({ type: TokenType.FAT_ARROW, value: '=>', line: startLine, column: startColumn });
      pos += 2;
      column += 2;
      continue;
    }
    
    // Single-character operators
    const singleCharTokens: Record<string, TokenType> = {
      '+': TokenType.PLUS,
      '-': TokenType.MINUS,
      '*': TokenType.STAR,
      '/': TokenType.SLASH,
      '%': TokenType.PERCENT,
      '=': TokenType.EQ,
      '<': TokenType.LT,
      '>': TokenType.GT,
      '!': TokenType.NOT,
      '?': TokenType.QUESTION,
      '.': TokenType.DOT,
      ',': TokenType.COMMA,
      ':': TokenType.COLON,
      ';': TokenType.SEMICOLON,
      '(': TokenType.LPAREN,
      ')': TokenType.RPAREN,
      '{': TokenType.LBRACE,
      '}': TokenType.RBRACE,
      '[': TokenType.LBRACKET,
      ']': TokenType.RBRACKET,
    };
    
    if (singleCharTokens[char]) {
      tokens.push({ 
        type: singleCharTokens[char], 
        value: char, 
        line: startLine, 
        column: startColumn 
      });
      pos++;
      column++;
      continue;
    }
    
    throw new LexerError(`Unexpected character: ${char}`, startLine, startColumn);
  }
  
  tokens.push({ type: TokenType.EOF, value: '', line, column });
  return tokens;
}
