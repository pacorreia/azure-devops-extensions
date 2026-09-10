# AzDO Pipeline Diagrams

VS Code extension to visualize Azure DevOps YAML pipelines/templates and export diagrams.

## Implemented scope

- Parser + recursive template resolver + compile-time expression evaluator + tests.
- Preview webview with live updates, node-to-source reveal, and parameter controls.
- Diagram export to SVG/PNG/JPEG/PDF.
- Schema bundle + diagnostics + optional schema refresh.

## Commands

- `AzDO Diagram: Open Preview`
- `AzDO Diagram: Open Preview to the Side`
- `AzDO Diagram: Open Preview for File…`
- `AzDO Diagram: Export Diagram…`
- `AzDO Diagram: Refresh Schema`
- `AzDO Diagram: Map Repository…`

## Settings

- `azdoDiagram.organization`
- `azdoDiagram.schemaUrl`
- `azdoDiagram.repositoryMappings`
- `azdoDiagram.maxTemplateDepth`
- `azdoDiagram.parameterPresets`
- `azdoDiagram.defaultDetailLevel`
- `azdoDiagram.export.scale`
- `azdoDiagram.export.background`
- `azdoDiagram.export.includeParameters`
- `azdoDiagram.liveUpdateDebounceMs`

## Repository mapping flow

For `template: path@alias`, the resolver tries:
1. `azdoDiagram.repositoryMappings` (alias or repo name keys)
2. matching workspace folder name
3. interactive folder picker + optional save mapping
4. unresolved placeholder node + diagnostic

`self` maps to the current file repository root (nearest `.git` or workspace root).

## Limitations

- Runtime `$[ ]` expressions and runtime `condition` logic are not evaluated; conditions are shown as labels.
- Compare mode UI and full org-specific schema merge are future improvements.

## Development

```bash
npm ci
npm run lint
npm run build
npm test
```
