import type { PipelineGraph } from './types';
import type { ProvenanceFrame } from '../resolver/types';

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function toStr(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v : fallback;
}

export function buildGraph(expanded: Record<string, unknown>, provenanceByPath: Record<string, ProvenanceFrame[]> = {}): PipelineGraph {
  const sourceFile = (pathKey: string): string | undefined => provenanceByPath[pathKey]?.at(-1)?.file;
  const nodes: PipelineGraph['nodes'] = [];
  const edges: PipelineGraph['edges'] = [];
  nodes.push({ id: 'pipeline', label: toStr(expanded.name, 'Pipeline'), kind: 'pipeline', file: sourceFile('$') });

  const stages = asArray<Record<string, unknown>>(expanded.stages);
  const hasStages = stages.length > 0;
  const topLevelJobs = asArray<Record<string, unknown>>(expanded.jobs);
  const usesTopLevelJobs = !hasStages && topLevelJobs.length > 0;
  const normalizedStages = hasStages
    ? stages
    : [{ stage: 'default', jobs: usesTopLevelJobs ? topLevelJobs : [{ job: 'default', steps: expanded.steps ?? [] }] } as Record<string, unknown>];
  const stageIds = normalizedStages.map((stage, i) => ({ id: `stage:${i}`, name: String(stage.stage ?? `Stage ${i + 1}`) }));

  let prevStageId: string | undefined;
  for (let s = 0; s < normalizedStages.length; s += 1) {
    const stage = normalizedStages[s];
    const stageId = `stage:${s}`;
    const stagePath = hasStages ? `$.stages[${s}]` : '$';
    nodes.push({ id: stageId, label: toStr(stage.stage, `Stage ${s + 1}`), kind: 'stage', parentId: 'pipeline', condition: typeof stage.condition === 'string' ? stage.condition : undefined, file: sourceFile(stagePath) });
    edges.push({ id: `e:pipeline:${stageId}`, source: 'pipeline', target: stageId });

    const dependsOn = stage.dependsOn;
    const stageDeps = typeof dependsOn === 'string' ? [dependsOn] : Array.isArray(dependsOn) ? dependsOn : [];
    if (stageDeps.length > 0) {
      for (const dep of stageDeps) {
        const depId = stageIds.find((x) => x.name === dep)?.id;
        if (depId) {
          edges.push({ id: `e:${depId}:${stageId}`, source: depId, target: stageId });
        }
      }
    } else if (prevStageId) {
      edges.push({ id: `e:${prevStageId}:${stageId}`, source: prevStageId, target: stageId });
    }
    prevStageId = stageId;

    const jobs = asArray<Record<string, unknown>>(stage.jobs);
    for (let j = 0; j < jobs.length; j += 1) {
      const job = jobs[j];
      const jobId = `${stageId}:job:${j}`;
      const isDeployment = 'deployment' in job;
      const jobPath = hasStages ? `${stagePath}.jobs[${j}]` : usesTopLevelJobs ? `$.jobs[${j}]` : '$';
      nodes.push({ id: jobId, label: toStr(job.job ?? job.deployment, `Job ${j + 1}`), kind: isDeployment ? 'deployment' : 'job', parentId: stageId, condition: typeof job.condition === 'string' ? job.condition : undefined, file: sourceFile(jobPath) });
      edges.push({ id: `e:${stageId}:${jobId}`, source: stageId, target: jobId });

      if (job.strategy && typeof job.strategy === 'object') {
        const matrix = (job.strategy as Record<string, unknown>).matrix;
        if (matrix && typeof matrix === 'object') {
          for (const key of Object.keys(matrix as Record<string, unknown>)) {
            const mId = `${jobId}:matrix:${key}`;
            nodes.push({ id: mId, label: key, kind: 'matrix-child', parentId: jobId, file: sourceFile(jobPath) });
            edges.push({ id: `e:${jobId}:${mId}`, source: jobId, target: mId });
          }
        }
      }

      const depends = job.dependsOn;
      const depList = typeof depends === 'string' ? [depends] : Array.isArray(depends) ? depends : [];
      for (const dep of depList) {
        const idx = jobs.findIndex((j2) => String(j2.job ?? j2.deployment) === dep);
        if (idx >= 0) {
          edges.push({ id: `e:${stageId}:job:${idx}->${jobId}`, source: `${stageId}:job:${idx}`, target: jobId, label: typeof job.condition === 'string' ? job.condition : undefined });
        }
      }

      const deploymentSteps = (((job.strategy as Record<string, unknown> | undefined)?.runOnce as Record<string, unknown> | undefined)?.deploy as Record<string, unknown> | undefined)?.steps;
      const steps = asArray<Record<string, unknown>>(job.steps ?? deploymentSteps);
      const stepPathPrefix = hasStages || usesTopLevelJobs
        ? (job.steps ? `${jobPath}.steps` : `${jobPath}.strategy.runOnce.deploy.steps`)
        : '$.steps';
      let prevStepId: string | undefined;
      for (let k = 0; k < steps.length; k += 1) {
        const step = steps[k];
        const stepId = `${jobId}:step:${k}`;
        const label = toStr(step.displayName ?? step.task ?? step.script ?? step.bash ?? step.powershell, `Step ${k + 1}`);
        nodes.push({ id: stepId, label, kind: 'step', parentId: jobId, condition: typeof step.condition === 'string' ? step.condition : undefined, file: sourceFile(`${stepPathPrefix}[${k}]`) });
        edges.push({ id: `e:${jobId}:${stepId}`, source: jobId, target: stepId });
        if (prevStepId) {
          edges.push({ id: `e:${prevStepId}:${stepId}`, source: prevStepId, target: stepId });
        }
        prevStepId = stepId;
      }
    }
  }

  return { nodes, edges };
}
