import type { SourceRange } from '../parser/types';
import type { ProvenanceFrame } from '../resolver/types';

export type DetailLevel = 'stages' | 'jobs' | 'full';

export interface GraphNode {
  id: string;
  label: string;
  kind: 'pipeline' | 'stage' | 'job' | 'deployment' | 'step' | 'placeholder' | 'matrix-child';
  parentId?: string;
  file?: string;
  range?: SourceRange;
  condition?: string;
  provenance?: ProvenanceFrame[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

export interface PipelineGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
