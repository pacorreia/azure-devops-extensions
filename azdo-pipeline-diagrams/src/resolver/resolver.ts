import { parsePipelineDocument } from '../parser';
import type { ParameterDeclaration } from '../parser/types';
import { stableStringify } from '../util/hash';
import { evaluateExpression, isExpressionTemplate, unwrapExpressionTemplate, type ExpressionContext } from './expressions';
import type { ProvenanceFrame, ResolveInput, ResolveResult, ResolverDiagnostic, ResolverHost, ResolverSettings } from './types';

interface ResolveContext {
  rootFile: string;
  rootRepositoryRoot: string;
  currentFile: string;
  rootRepositories: Record<string, { alias: string; name?: string }>;
  parameters: Record<string, unknown>;
  variables: Record<string, unknown>;
  locals?: Record<string, unknown>;
  chain: ProvenanceFrame[];
  depth: number;
}

const TEMPLATE_KEY_RE = /^\$\{\{\s*(if|elseif|else|each|insert)(.*)\}\}$/;

export class PipelineResolver {
  private parsedCache = new Map<string, unknown>();
  private expansionCache = new Map<string, unknown>();
  private diagnostics: ResolverDiagnostic[] = [];
  private dependencies = new Set<string>();
  private provenanceByPath: Record<string, ProvenanceFrame[]> = {};

  constructor(private readonly host: ResolverHost, private readonly settings: ResolverSettings) {}

  async resolve(input: ResolveInput): Promise<ResolveResult> {
    this.parsedCache.clear();
    this.expansionCache.clear();
    this.diagnostics = [];
    this.dependencies = new Set([this.host.normalize(input.rootFile)]);
    this.provenanceByPath = {};

    const parsed = parsePipelineDocument(input.rootFile, input.rootContent);
    const rootObj = (parsed.js ?? {}) as Record<string, unknown>;
    const parameters = this.extractParameters(rootObj.parameters).reduce<Record<string, unknown>>((acc, p) => {
      acc[p.name] = p.defaultValue;
      return acc;
    }, {});
    Object.assign(parameters, input.parameterOverrides ?? {});

    const rootRepositories = this.extractRepositories(rootObj.resources);
    const context: ResolveContext = {
      rootFile: input.rootFile,
      rootRepositoryRoot: (await this.host.resolveRepository('self', undefined, input.rootFile)) ?? this.host.dirname(input.rootFile),
      currentFile: input.rootFile,
      rootRepositories,
      parameters,
      variables: this.extractVariables(rootObj.variables),
      chain: [{ file: input.rootFile }],
      depth: 0
    };

    const expanded = await this.expandAny(rootObj, context, new Set<string>(), '$') as Record<string, unknown>;
    return {
      expanded,
      diagnostics: [...parsed.diagnostics.map((d) => ({ file: input.rootFile, message: d.message, severity: d.severity, range: d.range })), ...this.diagnostics],
      dependencies: [...this.dependencies],
      parameters: this.extractParameters(rootObj.parameters),
      provenanceByPath: this.provenanceByPath
    };
  }

  private extractParameters(node: unknown): ParameterDeclaration[] {
    if (!Array.isArray(node)) return [];
    return node.flatMap((entry) => {
      if (typeof entry === 'string') {
        return [{ name: entry, type: 'string' }];
      }
      if (entry && typeof entry === 'object') {
        const obj = entry as Record<string, unknown>;
        if ('name' in obj) {
          return [{ name: String(obj.name), type: String(obj.type ?? 'string'), defaultValue: obj.default, values: Array.isArray(obj.values) ? obj.values : undefined }];
        }
        const key = Object.keys(obj)[0];
        if (key) {
          return [{ name: key, type: 'string', defaultValue: obj[key] }];
        }
      }
      return [];
    });
  }

  private extractRepositories(node: unknown): Record<string, { alias: string; name?: string }> {
    const result: Record<string, { alias: string; name?: string }> = { self: { alias: 'self' } };
    const repos = (node as Record<string, unknown> | undefined)?.repositories;
    if (!Array.isArray(repos)) return result;
    for (const r of repos) {
      if (!r || typeof r !== 'object') continue;
      const obj = r as Record<string, unknown>;
      const alias = String(obj.repository ?? obj.alias ?? '');
      if (!alias) continue;
      result[alias] = { alias, name: typeof obj.name === 'string' ? obj.name : undefined };
    }
    return result;
  }

  private extractVariables(node: unknown): Record<string, unknown> {
    if (!node) return {};
    if (Array.isArray(node)) {
      const acc: Record<string, unknown> = {};
      for (const item of node) {
        if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          if (obj.name) acc[String(obj.name)] = obj.value;
          if (obj.template) continue;
          for (const [k, v] of Object.entries(obj)) {
            if (k !== 'name' && k !== 'value') acc[k] = v;
          }
        }
      }
      return acc;
    }
    if (typeof node === 'object') return node as Record<string, unknown>;
    return {};
  }

  private addDiagnostic(file: string, message: string, severity: 'error' | 'warning' = 'warning'): void {
    this.diagnostics.push({ file, message, severity });
  }

  private getExprContext(ctx: ResolveContext): ExpressionContext {
    return { parameters: ctx.parameters, variables: ctx.variables, locals: ctx.locals };
  }

  private annotate(path: string, chain: ProvenanceFrame[]): void {
    this.provenanceByPath[path] = chain;
  }

  private async expandAny(value: unknown, ctx: ResolveContext, stack: Set<string>, path: string): Promise<unknown> {
    this.annotate(path, ctx.chain);

    if (typeof value === 'string' && isExpressionTemplate(value)) {
      return evaluateExpression(unwrapExpressionTemplate(value), this.getExprContext(ctx));
    }

    if (Array.isArray(value)) {
      const output: unknown[] = [];
      for (let i = 0; i < value.length; i += 1) {
        const item = value[i];
        if (item && typeof item === 'object' && !Array.isArray(item) && 'template' in (item as Record<string, unknown>)) {
          const expandedTemplate = await this.expandTemplateReference(item as Record<string, unknown>, ctx, stack, `${path}[${i}]`);
          if (Array.isArray(expandedTemplate)) {
            output.push(...expandedTemplate);
          } else if (expandedTemplate !== undefined) {
            output.push(expandedTemplate);
          }
          continue;
        }
        const expanded = await this.expandAny(item, ctx, stack, `${path}[${i}]`);
        if (Array.isArray(expanded)) {
          output.push(...expanded);
        } else if (expanded !== undefined) {
          output.push(expanded);
        }
      }
      return output;
    }

    if (value && typeof value === 'object') {
      const input = value as Record<string, unknown>;

      if ('extends' in input && input.extends && typeof input.extends === 'object') {
        const base = await this.expandTemplateReference(input.extends as Record<string, unknown>, ctx, stack, path);
        const local = { ...input };
        delete local.extends;
        const expandedLocal = await this.expandAny(local, ctx, stack, path);
        if (base && typeof base === 'object' && !Array.isArray(base) && expandedLocal && typeof expandedLocal === 'object' && !Array.isArray(expandedLocal)) {
          return { ...(base as Record<string, unknown>), ...(expandedLocal as Record<string, unknown>) };
        }
        return expandedLocal ?? base;
      }

      const output: Record<string, unknown> = {};
      const entries = Object.entries(input);
      let branchSelected = false;
      for (const [key, val] of entries) {
        const ctrl = key.match(TEMPLATE_KEY_RE);
        if (ctrl) {
          const kind = ctrl[1];
          const body = ctrl[2].trim();
          if (kind === 'if' || kind === 'elseif') {
            if (branchSelected) continue;
            const condition = kind === 'if' ? body : body;
            if (evaluateExpression(condition, this.getExprContext(ctx))) {
              branchSelected = true;
              const expanded = await this.expandAny(val, ctx, stack, `${path}.${key}`);
              if (expanded && typeof expanded === 'object' && !Array.isArray(expanded)) Object.assign(output, expanded as Record<string, unknown>);
              if (Array.isArray(expanded)) output.__insertedArray = [...(output.__insertedArray as unknown[] ?? []), ...expanded];
            }
            continue;
          }
          if (kind === 'else') {
            if (!branchSelected) {
              const expanded = await this.expandAny(val, ctx, stack, `${path}.${key}`);
              if (expanded && typeof expanded === 'object' && !Array.isArray(expanded)) Object.assign(output, expanded as Record<string, unknown>);
              if (Array.isArray(expanded)) output.__insertedArray = [...(output.__insertedArray as unknown[] ?? []), ...expanded];
            }
            continue;
          }
          if (kind === 'each') {
            const eachMatch = body.match(/^(\w+)\s+in\s+(.+)$/);
            if (!eachMatch) continue;
            const localName = eachMatch[1];
            const iterable = evaluateExpression(eachMatch[2], this.getExprContext(ctx));
            const entriesList = Array.isArray(iterable) ? iterable.map((v, i) => [i, v]) : Object.entries((iterable ?? {}) as Record<string, unknown>);
            for (const [, item] of entriesList) {
              const eachCtx: ResolveContext = { ...ctx, locals: { ...(ctx.locals ?? {}), [localName]: item } };
              const expanded = await this.expandAny(val, eachCtx, stack, `${path}.${key}`);
              if (Array.isArray(expanded)) {
                output.__insertedArray = [...(output.__insertedArray as unknown[] ?? []), ...expanded];
              } else if (expanded && typeof expanded === 'object') {
                Object.assign(output, expanded as Record<string, unknown>);
              }
            }
            continue;
          }
          if (kind === 'insert') {
            const expanded = await this.expandAny(val, ctx, stack, `${path}.${key}`);
            if (expanded && typeof expanded === 'object' && !Array.isArray(expanded)) Object.assign(output, expanded as Record<string, unknown>);
            continue;
          }
        }

        const expandedValue = await this.expandAny(val, ctx, stack, `${path}.${key}`);
        output[key] = expandedValue;
      }

      if (Array.isArray(output.__insertedArray)) {
        return output.__insertedArray;
      }
      return output;
    }

    return value;
  }

  private async readParsed(file: string): Promise<Record<string, unknown> | undefined> {
    const norm = this.host.normalize(file);
    if (this.parsedCache.has(norm)) {
      return this.parsedCache.get(norm) as Record<string, unknown>;
    }
    if (!(await this.host.fileExists(norm))) {
      return undefined;
    }
    const text = await this.host.readFile(norm);
    const parsed = parsePipelineDocument(norm, text);
    const obj = (parsed.js ?? {}) as Record<string, unknown>;
    this.parsedCache.set(norm, obj);
    this.dependencies.add(norm);
    for (const d of parsed.diagnostics) {
      this.diagnostics.push({ file: norm, message: d.message, severity: d.severity, range: d.range });
    }
    return obj;
  }

  private async expandTemplateReference(templateNode: Record<string, unknown>, ctx: ResolveContext, stack: Set<string>, path: string): Promise<unknown> {
    if (ctx.depth >= this.settings.maxTemplateDepth) {
      this.addDiagnostic(ctx.currentFile, `Maximum template depth (${this.settings.maxTemplateDepth}) reached.`);
      return { type: 'placeholder', reason: 'max-depth', template: templateNode.template };
    }

    const templateRef = String(templateNode.template ?? '');
    if (!templateRef) {
      return undefined;
    }

    let templatePath = templateRef;
    let alias = 'self';
    if (templateRef.includes('@')) {
      const [pathPart, aliasPart] = templateRef.split('@');
      templatePath = pathPart;
      alias = aliasPart || 'self';
    }

    let repoRoot: string | undefined;
    if (alias === 'self') {
      repoRoot = ctx.rootRepositoryRoot;
    } else {
      const repo = ctx.rootRepositories[alias];
      repoRoot = await this.host.resolveRepository(alias, repo?.name, ctx.rootFile);
      if (!repoRoot) {
        this.addDiagnostic(ctx.currentFile, `Unresolved repository alias '${alias}' for template '${templateRef}'.`);
        return { type: 'placeholder', reason: 'unresolved-repository', template: templateRef };
      }
    }

    const normalizedRepoRoot = this.host.normalize(repoRoot);
    const resolvedFile = this.host.normalize(this.host.resolvePath(normalizedRepoRoot, templatePath));
    const escapedRoot = normalizedRepoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const inRoot = new RegExp(`^${escapedRoot}(?:[\\\\/]|$)`).test(resolvedFile);
    if (!inRoot) {
      this.addDiagnostic(ctx.currentFile, `Template path escapes repository root: ${templateRef}`, 'error');
      return { type: 'placeholder', reason: 'invalid-template-path', template: templateRef };
    }
    const passedParams = (templateNode.parameters && typeof templateNode.parameters === 'object') ? (await this.expandAny(templateNode.parameters, ctx, stack, `${path}.parameters`)) as Record<string, unknown> : {};

    const cacheKey = `${resolvedFile}::${stableStringify(passedParams)}`;
    if (this.expansionCache.has(cacheKey)) {
      return this.expansionCache.get(cacheKey);
    }

    const stackKey = cacheKey;
    if (stack.has(stackKey)) {
      this.addDiagnostic(ctx.currentFile, `Template cycle detected at '${templateRef}'.`, 'error');
      return { type: 'placeholder', reason: 'cycle', template: templateRef };
    }

    const parsed = await this.readParsed(resolvedFile);
    if (!parsed) {
      this.addDiagnostic(ctx.currentFile, `Template file not found: ${resolvedFile}`);
      return { type: 'placeholder', reason: 'missing-template', template: templateRef };
    }

    const declared = this.extractParameters(parsed.parameters);
    const localParams = declared.reduce<Record<string, unknown>>((acc, p) => {
      acc[p.name] = p.defaultValue;
      return acc;
    }, {});
    Object.assign(localParams, passedParams);

    stack.add(stackKey);
    const localCtx: ResolveContext = {
      ...ctx,
      currentFile: resolvedFile,
      parameters: localParams,
      variables: { ...ctx.variables, ...this.extractVariables(parsed.variables) },
      chain: [...ctx.chain, { file: resolvedFile, templateRef }],
      depth: ctx.depth + 1,
      locals: undefined
    };

    const expanded = await this.expandAny(parsed, localCtx, stack, path);
    stack.delete(stackKey);
    this.expansionCache.set(cacheKey, expanded);
    return expanded;
  }
}
