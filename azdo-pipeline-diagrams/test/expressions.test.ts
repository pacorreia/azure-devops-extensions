import { describe, expect, it } from 'vitest';
import { evaluateExpression } from '../src/resolver/expressions';

const ctx = { parameters: { env: 'prod', items: ['a', 'b'], obj: { key: 'v' }, flag: true }, variables: { branch: 'main' } };

describe('expression evaluator', () => {
  it('evaluates property access', () => {
    expect(evaluateExpression('parameters.env', ctx)).toBe('prod');
    expect(evaluateExpression("parameters['env']", ctx)).toBe('prod');
  });

  it('evaluates boolean and compare funcs', () => {
    expect(evaluateExpression("eq(parameters.env, 'prod')", ctx)).toBe(true);
    expect(evaluateExpression('and(true, not(false))', ctx)).toBe(true);
    expect(evaluateExpression("in(parameters.env, 'dev', 'prod')", ctx)).toBe(true);
  });

  it('evaluates string/list funcs', () => {
    expect(evaluateExpression("startsWith(variables.branch, 'ma')", ctx)).toBe(true);
    expect(evaluateExpression('length(parameters.items)', ctx)).toBe(2);
    expect(evaluateExpression("format('{0}-{1}', 'a', 'b')", ctx)).toBe('a-b');
  });

  it('evaluates each-style local variables', () => {
    const localCtx = { ...ctx, locals: { service: { name: 'api' } } };
    expect(evaluateExpression('service.name', localCtx)).toBe('api');
    expect(evaluateExpression("service['name']", localCtx)).toBe('api');
  });

  it('handles undefined literal', () => {
    expect(evaluateExpression('undefined', ctx)).toBeUndefined();
  });
});
