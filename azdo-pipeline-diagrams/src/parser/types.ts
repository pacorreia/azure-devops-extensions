export interface Position {
  line: number;
  column: number;
}

export interface SourceRange {
  start: Position;
  end: Position;
}

export interface ParseDiagnostic {
  message: string;
  severity: 'error' | 'warning';
  range?: SourceRange;
}

export type PipelineDocumentKind = 'pipeline' | 'template' | 'unknown';

export interface ParsedPipelineDocument {
  uri: string;
  text: string;
  js: unknown;
  kind: PipelineDocumentKind;
  diagnostics: ParseDiagnostic[];
  range?: SourceRange;
}

export interface ParameterDeclaration {
  name: string;
  type: string;
  defaultValue?: unknown;
  values?: unknown[];
}
