import type { ParameterDeclaration, SourceRange } from '../parser/types';

export interface ResolverDiagnostic {
  file: string;
  message: string;
  severity: 'error' | 'warning';
  range?: SourceRange;
}

export interface ProvenanceFrame {
  file: string;
  templateRef?: string;
}

export interface ResolverHost {
  readFile(path: string): Promise<string>;
  fileExists(path: string): Promise<boolean>;
  realpath(path: string): Promise<string>;
  resolveRepository(alias: string, repoName: string | undefined, rootFile: string): Promise<string | undefined>;
  dirname(path: string): string;
  join(...parts: string[]): string;
  resolvePath(...parts: string[]): string;
  normalize(path: string): string;
}

export interface ResolverSettings {
  maxTemplateDepth: number;
}

export interface ResolveInput {
  rootFile: string;
  rootContent: string;
  parameterOverrides?: Record<string, unknown>;
}

export interface ResolveResult {
  expanded: Record<string, unknown>;
  diagnostics: ResolverDiagnostic[];
  dependencies: string[];
  parameters: ParameterDeclaration[];
  provenanceByPath: Record<string, ProvenanceFrame[]>;
}
