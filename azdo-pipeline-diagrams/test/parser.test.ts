import { describe, expect, it } from 'vitest';
import { parsePipelineDocument, detectDocumentKind } from '../src/parser';

describe('parser', () => {
  it('detects pipeline kind', () => {
    expect(detectDocumentKind({ stages: [] })).toBe('pipeline');
  });

  it('detects template kind', () => {
    expect(detectDocumentKind({ parameters: [], jobs: [] })).toBe('template');
  });

  it('parses yaml diagnostics', () => {
    const parsed = parsePipelineDocument('/tmp/p.yml', 'stages:\n  - stage: A\n   bad: value');
    expect(parsed.diagnostics.length).toBeGreaterThan(0);
  });
});
