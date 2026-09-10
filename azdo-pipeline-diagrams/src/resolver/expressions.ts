const functionTable: Record<string, (...args: unknown[]) => unknown> = {
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  and: (...a) => a.every(Boolean),
  or: (...a) => a.some(Boolean),
  not: (a) => !a,
  xor: (a, b) => Boolean(a) !== Boolean(b),
  contains: (a, b) => String(a ?? '').includes(String(b ?? '')),
  containsValue: (a, b) => Array.isArray(a) ? a.includes(b) : Object.values((a ?? {}) as Record<string, unknown>).includes(b),
  startsWith: (a, b) => String(a ?? '').startsWith(String(b ?? '')),
  endsWith: (a, b) => String(a ?? '').endsWith(String(b ?? '')),
  in: (a, ...list) => list.includes(a),
  notIn: (a, ...list) => !list.includes(a),
  coalesce: (...a) => a.find((x) => x !== null && x !== undefined && x !== ''),
  format: (fmt, ...a) => String(fmt ?? '').replace(/\{(\d+)\}/g, (_, i) => String(a[Number(i)] ?? '')),
  length: (a) => (Array.isArray(a) || typeof a === 'string') ? a.length : Object.keys((a ?? {}) as Record<string, unknown>).length,
  lower: (a) => String(a ?? '').toLowerCase(),
  upper: (a) => String(a ?? '').toUpperCase(),
  join: (sep, arr) => Array.isArray(arr) ? arr.join(String(sep ?? '')) : '',
  split: (val, sep) => String(val ?? '').split(String(sep ?? '')),
  replace: (val, search, repl) => String(val ?? '').split(String(search ?? '')).join(String(repl ?? '')),
  convertToJson: (v) => JSON.stringify(v),
  counter: () => 0
};

export interface ExpressionContext {
  parameters: Record<string, unknown>;
  variables: Record<string, unknown>;
  locals?: Record<string, unknown>;
}

function splitArgs(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  let quote: string | undefined;
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function resolvePath(base: unknown, path: string): unknown {
  const steps = path.split('.').filter(Boolean);
  let cur: unknown = base;
  for (const step of steps) {
    if (cur && typeof cur === 'object' && step in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[step];
    } else {
      return undefined;
    }
  }
  return cur;
}

function parseLiteral(token: string): unknown {
  if (/^'.*'$/.test(token) || /^".*"$/.test(token)) return token.slice(1, -1);
  if (token === 'true') return true;
  if (token === 'false') return false;
  if (token === 'null') return null;
  if (!Number.isNaN(Number(token))) return Number(token);
  return undefined;
}

export function evaluateExpression(input: string, ctx: ExpressionContext): unknown {
  const expr = input.trim();
  const lit = parseLiteral(expr);
  if (lit !== undefined || expr === 'undefined') return lit;

  if (ctx.locals) {
    for (const [name, value] of Object.entries(ctx.locals)) {
      if (expr === name) return value;
      if (expr.startsWith(`${name}.`)) return resolvePath(value, expr.slice(name.length + 1));
      if (expr.startsWith(`${name}['`) && expr.endsWith(`']`)) return (value as Record<string, unknown>)?.[expr.slice(name.length + 2, -2)];
    }
  }

  if (expr.startsWith('parameters.')) return resolvePath(ctx.parameters, expr.slice('parameters.'.length));
  if (expr.startsWith('variables.')) return resolvePath(ctx.variables, expr.slice('variables.'.length));
  if (expr.startsWith("parameters['") && expr.endsWith("']")) return ctx.parameters[expr.slice(12, -2)];
  if (expr.startsWith("variables['") && expr.endsWith("']")) return ctx.variables[expr.slice(10, -2)];

  const fnMatch = expr.match(/^([a-zA-Z_][\w]*)\((.*)\)$/);
  if (fnMatch) {
    const fn = functionTable[fnMatch[1]];
    if (!fn) return undefined;
    const args = splitArgs(fnMatch[2]).map((a) => evaluateExpression(a, ctx));
    return fn(...args);
  }

  return undefined;
}

export function isExpressionTemplate(text: string): boolean {
  return /^\$\{\{[\s\S]+\}\}$/.test(text.trim());
}

export function unwrapExpressionTemplate(text: string): string {
  return text.trim().replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '');
}
