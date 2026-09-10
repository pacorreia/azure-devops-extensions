import type * as vscode from 'vscode';
import bundledSchema from './service-schema.json';

const CACHE_KEY = 'azdoDiagram.schema.cache';
const CACHE_URL_KEY = 'azdoDiagram.schema.cacheUrl';

export class SchemaService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  getBundledSchema(): unknown {
    return bundledSchema;
  }

  async getActiveSchema(configuration: vscode.WorkspaceConfiguration): Promise<unknown> {
    const org = configuration.get<string>('organization');
    const schemaUrl = configuration.get<string>('schemaUrl') || (org ? `https://dev.azure.com/${org}/_apis/distributedtask/yamlschema` : undefined);
    if (!schemaUrl) {
      return bundledSchema;
    }
    const cached = this.context.globalState.get(CACHE_KEY);
    const cachedUrl = this.context.globalState.get<string>(CACHE_URL_KEY);
    if (cached && cachedUrl === schemaUrl) {
      return cached;
    }
    try {
      await this.refreshSchema(configuration);
      return this.context.globalState.get(CACHE_KEY) ?? bundledSchema;
    } catch {
      return bundledSchema;
    }
  }

  async refreshSchema(configuration: vscode.WorkspaceConfiguration): Promise<void> {
    const org = configuration.get<string>('organization');
    const schemaUrl = configuration.get<string>('schemaUrl') || (org ? `https://dev.azure.com/${org}/_apis/distributedtask/yamlschema` : undefined);
    if (!schemaUrl) {
      await this.context.globalState.update(CACHE_KEY, undefined);
      await this.context.globalState.update(CACHE_URL_KEY, undefined);
      return;
    }

    const response = await fetch(schemaUrl);
    if (!response.ok) throw new Error(`Schema fetch failed: ${response.status}`);
    const schema = await response.json();
    await this.context.globalState.update(CACHE_KEY, schema);
    await this.context.globalState.update(CACHE_URL_KEY, schemaUrl);
  }
}
