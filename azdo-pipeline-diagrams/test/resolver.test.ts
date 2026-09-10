import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/model/buildGraph';
import { PipelineResolver } from '../src/resolver/resolver';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.resolve(here, 'fixtures', name);

function createHost(rootMap: Record<string, string> = {}) {
  return {
    readFile: (p: string) => fs.readFile(p, 'utf8'),
    async fileExists(p: string) { try { await fs.access(p); return true; } catch { return false; } },
    realpath: (p: string) => fs.realpath(p),
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
    const jobs = stages[0].jobs as Array<Record<string, unknown>>;
    expect(jobs[0].job).toBe('Build');
    const steps = jobs[0].steps as Array<Record<string, unknown>>;
    expect(steps[0].script).toBe('echo test demo');
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
    expect(stages).toHaveLength(2);
    expect(stages.every((stage) => !Array.isArray(stage) && typeof stage === 'object')).toBe(true);
    const buildSteps = (stages[0].jobs as Array<Record<string, unknown>>)[0].steps as Array<Record<string, unknown>>;
    expect(buildSteps).toHaveLength(1);
    expect(buildSteps[0].script).toBe('echo build');
    expect(stages[1].stage).toBe('Deploy_api');
    const deploySteps = (stages[1].jobs as Array<Record<string, unknown>>)[0].steps as Array<Record<string, unknown>>;
    expect(deploySteps[0].script).toBe('echo deploy api');
  });

  it('re-emits dependencies when the same resolver instance is reused', async () => {
    const resolver = new PipelineResolver(createHost({ common: path.dirname(fixture('base.yml')) }), { maxTemplateDepth: 20 });
    const root = fixture('root-extends.yml');
    const rootContent = await fs.readFile(root, 'utf8');
    const base = fixture('base.yml');

    const first = await resolver.resolve({ rootFile: root, rootContent });
    const second = await resolver.resolve({ rootFile: root, rootContent });

    expect(first.dependencies).toContain(base);
    expect(second.dependencies).toContain(base);
  });

  it('maps deployment strategy steps back to their source file', async () => {
    const resolver = new PipelineResolver(createHost(), { maxTemplateDepth: 20 });
    const root = fixture('simple.yml');
    const result = await resolver.resolve({ rootFile: root, rootContent: await fs.readFile(root, 'utf8') });
    const graph = buildGraph(result.expanded, result.provenanceByPath);
    const deployStep = graph.nodes.find((node) => node.kind === 'step' && node.label === 'echo deploy');

    expect(deployStep?.file).toBe(root);
  });

  it('preserves template provenance when using extends', async () => {
    const resolver = new PipelineResolver(createHost({ common: path.dirname(fixture('base.yml')) }), { maxTemplateDepth: 20 });
    const root = fixture('root-extends.yml');
    const result = await resolver.resolve({ rootFile: root, rootContent: await fs.readFile(root, 'utf8') });
    const graph = buildGraph(result.expanded, result.provenanceByPath);
    const buildStage = graph.nodes.find((node) => node.kind === 'stage' && node.label === 'Build');
    const testStep = graph.nodes.find((node) => node.kind === 'step' && node.label === 'echo test demo');

    expect(buildStage?.file).toBe(fixture('base.yml'));
    expect(testStep?.file).toBe(fixture('steps-test.yml'));
  });

  it('rejects templates that escape the repository root through symlinks', async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'resolver-symlink-'));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'resolver-outside-'));
    try {
      const root = path.join(tempRoot, 'root.yml');
      const outsideTemplate = path.join(outsideRoot, 'outside.yml');
      const linkedTemplate = path.join(tempRoot, 'linked.yml');
      await fs.writeFile(root, 'steps:\n  - template: linked.yml\n', 'utf8');
      await fs.writeFile(outsideTemplate, 'steps:\n  - script: echo outside\n', 'utf8');
      await fs.symlink(outsideTemplate, linkedTemplate);

      const resolver = new PipelineResolver(createHost(), { maxTemplateDepth: 20 });
      const result = await resolver.resolve({ rootFile: root, rootContent: await fs.readFile(root, 'utf8') });

      expect(result.diagnostics.some((d) => d.message.includes('Template path escapes repository root'))).toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});
