import { LineCounter, parseDocument } from 'yaml';
import type { ParsedPipelineDocument, PipelineDocumentKind, SourceRange } from './types';

function toRange(range: [number, number, number] | undefined, lc: LineCounter): SourceRange | undefined {
  if (!range) {
    return undefined;
  }
  const start = lc.linePos(range[0]);
  const end = lc.linePos(range[1]);
  return { start: { line: start.line - 1, column: start.col - 1 }, end: { line: end.line - 1, column: end.col - 1 } };
}

export function detectDocumentKind(js: unknown): PipelineDocumentKind {
  if (!js || typeof js !== 'object') {
    return 'unknown';
  }
  const obj = js as Record<string, unknown>;
  const hasPipelineKeys = ['stages', 'jobs', 'steps', 'extends'].some((k) => k in obj);
  const hasTemplate = 'parameters' in obj && ['stages', 'jobs', 'steps', 'variables'].some((k) => k in obj);
  const hasRootPipelineOnlyKeys = ['trigger', 'pr', 'resources', 'extends'].some((k) => k in obj);
  if (hasTemplate && !hasRootPipelineOnlyKeys) {
    return 'template';
  }
  if (hasPipelineKeys) {
    return 'pipeline';
  }
  return 'unknown';
}

export function parsePipelineDocument(uri: string, text: string): ParsedPipelineDocument {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  const diagnostics = doc.errors.map((e) => ({ message: e.message, severity: 'error' as const, range: toRange(e.pos, lineCounter) }));
  const js = doc.toJS();
  return {
    uri,
    text,
    js,
    kind: detectDocumentKind(js),
    diagnostics,
    range: toRange(doc.contents?.range, lineCounter)
  };
}
