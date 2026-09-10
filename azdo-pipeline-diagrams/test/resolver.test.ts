import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PipelineResolver } from '../src/resolver/resolver';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.resolve(here, 'fixtures', name);

function createHost(rootMap: Record<string, string> = {}) {
  return {
    readFile: (p: string) => fs.readFile(p, 'utf8'),
    async fileExists(p: string) { try { await fs.access(p); return true; } catch { return false; } },
    resolveRepository: async (alias: string) => rootMap[alias],
    dirname: (p: string) => path.dirname(p),
    join: (...parts: string[]) => path.join(...parts),
    resolvePath: (...parts: string[]) => path.resolve(...parts),
    normalize: (p: string) => path.normalize(p)
  };
}

describe('resolver', () => {
  it('resolves nested templates', async () => {
    const resolver = new PipelineResolver(createHost({ common: path.dirname(fixture('base.yml')) }), { maxTemplateDepth: 20 });
    const root = fixture('root-extends.yml');
    const result = await resolver.resolve({ rootFile: root, rootContent: await fs.readFile(root, 'utf8') });
    expect(result.diagnostics.length).toBe(0);
    const stages = result.expanded.stages as Array<Record<string, unknown>>;
    expect(stages[0].jobs).toBeTruthy();
  });

  it('reports unresolved repo alias', async () => {
    const resolver = new PipelineResolver(createHost(), { maxTemplateDepth: 20 });
    const root = fixture('unresolved-alias.yml');
    const result = await resolver.resolve({ rootFile: root, rootContent: await fs.readFile(root, 'utf8') });
    expect(result.diagnostics.some((d) => d.message.includes('Unresolved repository alias'))).toBe(true);
  });

  it('detects template cycle', async () => {
    const resolver = new PipelineResolver(createHost(), { maxTemplateDepth: 20 });
    const root = fixture('cycle-a.yml');
    const result = await resolver.resolve({ rootFile: root, rootContent: await fs.readFile(root, 'utf8') });
    expect(result.diagnostics.some((d) => d.message.includes('cycle'))).toBe(true);
  });

  it('applies parameter overrides in expressions', async () => {
    const resolver = new PipelineResolver(createHost(), { maxTemplateDepth: 20 });
    const root = fixture('parameters-if-each.yml');
    const result = await resolver.resolve({ rootFile: root, rootContent: await fs.readFile(root, 'utf8'), parameterOverrides: { runTests: false, services: ['api'] } });
    const stages = result.expanded.stages as Array<Record<string, unknown>>;
    expect(stages.length).toBeGreaterThan(0);
  });
});
