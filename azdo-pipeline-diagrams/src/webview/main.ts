import ELK from 'elkjs/lib/elk.bundled.js';
import { PDFDocument } from 'pdf-lib';

declare const acquireVsCodeApi: () => { postMessage(msg: unknown): void };

type Node = { id: string; label: string; kind: string; parentId?: string };
type Edge = { id: string; source: string; target: string; label?: string };

const vscode = acquireVsCodeApi();
const elk = new ELK();

const app = document.getElementById('app')!;
const toolbar = document.createElement('div');
toolbar.className = 'toolbar';
toolbar.innerHTML = `
<select id="detail"><option value="stages">Stages</option><option value="jobs" selected>Stages+Jobs</option><option value="full">Full</option></select>
<select id="direction"><option value="DOWN">TB</option><option value="RIGHT">LR</option></select>
<button id="fit">Fit</button>
<button id="export">Export</button>
<button id="params">Parameters</button>
<button id="compare">Compare</button>
`;
const content = document.createElement('div');
content.id = 'content';
const paramsPanel = document.createElement('div');
paramsPanel.id = 'params-panel';
paramsPanel.hidden = true;
app.append(toolbar, paramsPanel, content);

let currentGraph: { nodes: Node[]; edges: Edge[] } = { nodes: [], edges: [] };
let currentCompareGraph: { nodes: Node[]; edges: Edge[] } | undefined;
let currentSvg: SVGSVGElement | null = null;
let currentParameters: Array<{ name: string; type: string; values?: unknown[]; defaultValue?: unknown }> = [];

(document.getElementById('params') as HTMLButtonElement).onclick = () => { paramsPanel.hidden = !paramsPanel.hidden; };
(document.getElementById('export') as HTMLButtonElement).onclick = () => vscode.postMessage({ type: 'exportRequest' });
(document.getElementById('compare') as HTMLButtonElement).onclick = () => vscode.postMessage({ type: 'toggleCompare' });
(document.getElementById('detail') as HTMLSelectElement).onchange = (e) => vscode.postMessage({ type: 'detailLevel', value: (e.target as HTMLSelectElement).value });
(document.getElementById('direction') as HTMLSelectElement).onchange = () => render();

function signature(node: Node): string {
  return `${node.kind}:${node.label}`;
}

async function renderGraph(
  graph: { nodes: Node[]; edges: Edge[] },
  mount: HTMLElement,
  side: 'base' | 'compare',
  onlySet: Set<string>
): Promise<SVGSVGElement | null> {
  const dir = (document.getElementById('direction') as HTMLSelectElement).value;
  const layout = await elk.layout({
    id: 'root',
    layoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': dir, 'elk.layered.spacing.nodeNodeBetweenLayers': '60' },
    children: graph.nodes.map((n) => ({ id: n.id, width: 180, height: 56 })),
    edges: graph.edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] }))
  });

  const width = Math.max(400, ...(layout.children?.map((c) => (c.x ?? 0) + (c.width ?? 180)) ?? [400])) + 80;
  const height = Math.max(300, ...(layout.children?.map((c) => (c.y ?? 0) + (c.height ?? 56)) ?? [300])) + 80;

  const pos = new Map(layout.children?.map((c) => [c.id, c]) ?? []);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.classList.add('diagram');

  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  defs.innerHTML = '<marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto"><path d="M0,0 L10,3 L0,6 z" fill="currentColor"/></marker>';
  svg.appendChild(defs);

  for (const edge of graph.edges) {
    const s = pos.get(edge.source);
    const t = pos.get(edge.target);
    if (!s || !t) continue;
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String((s.x ?? 0) + 180));
    line.setAttribute('y1', String((s.y ?? 0) + 28));
    line.setAttribute('x2', String(t.x ?? 0));
    line.setAttribute('y2', String((t.y ?? 0) + 28));
    line.setAttribute('class', 'edge');
    line.setAttribute('marker-end', 'url(#arrow)');
    svg.appendChild(line);
  }

  for (const node of graph.nodes) {
    const p = pos.get(node.id);
    if (!p) continue;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.dataset.nodeId = node.id;
    const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    r.setAttribute('x', String(p.x ?? 0));
    r.setAttribute('y', String(p.y ?? 0));
    r.setAttribute('width', '180');
    r.setAttribute('height', '56');
    r.setAttribute('rx', '8');
    const extra = onlySet.has(signature(node)) ? ' diff-node' : '';
    r.setAttribute('class', `node ${node.kind}${extra}`);
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', String((p.x ?? 0) + 10));
    t.setAttribute('y', String((p.y ?? 0) + 30));
    t.setAttribute('class', 'label');
    t.textContent = node.label;
    g.append(r, t);
    g.addEventListener('click', () => vscode.postMessage({ type: 'revealNode', nodeId: `${side}:${node.id}` }));
    svg.appendChild(g);
  }

  mount.appendChild(svg);
  return svg;
}

async function render(): Promise<void> {
  content.innerHTML = '';
  if (!currentCompareGraph) {
    currentSvg = await renderGraph(currentGraph, content, 'base', new Set());
    return;
  }
  const split = document.createElement('div');
  split.className = 'compare-layout';
  const left = document.createElement('div');
  const right = document.createElement('div');
  left.className = 'compare-pane';
  right.className = 'compare-pane';
  left.innerHTML = '<h3>Base</h3>';
  right.innerHTML = '<h3>Compare</h3>';
  split.append(left, right);
  content.appendChild(split);

  const baseSet = new Set(currentGraph.nodes.map(signature));
  const compareSet = new Set(currentCompareGraph.nodes.map(signature));
  const onlyBase = new Set([...baseSet].filter((x) => !compareSet.has(x)));
  const onlyCompare = new Set([...compareSet].filter((x) => !baseSet.has(x)));
  currentSvg = await renderGraph(currentGraph, left, 'base', onlyBase);
  await renderGraph(currentCompareGraph, right, 'compare', onlyCompare);
}

function renderParameters(): void {
  paramsPanel.innerHTML = '';
  for (const p of currentParameters) {
    const row = document.createElement('div');
    row.className = 'param-row';
    const label = document.createElement('label');
    label.textContent = p.name;
    row.appendChild(label);

    let input: HTMLElement;
    if (p.type === 'boolean') {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(p.defaultValue);
      checkbox.onchange = () => vscode.postMessage({ type: 'parameterChanged', name: p.name, value: checkbox.checked });
      input = checkbox;
    } else if (Array.isArray(p.values) && p.values.length > 0) {
      const select = document.createElement('select');
      for (const v of p.values) {
        const opt = document.createElement('option');
        opt.value = String(v);
        opt.textContent = String(v);
        if (v === p.defaultValue) opt.selected = true;
        select.appendChild(opt);
      }
      select.onchange = () => vscode.postMessage({ type: 'parameterChanged', name: p.name, value: select.value });
      input = select;
    } else {
      const text = document.createElement('input');
      text.value = p.defaultValue === undefined ? '' : String(p.defaultValue);
      text.onchange = () => vscode.postMessage({ type: 'parameterChanged', name: p.name, value: text.value });
      input = text;
    }
    row.appendChild(input);
    paramsPanel.appendChild(row);
  }
}

async function exportImage(format: 'svg' | 'png' | 'jpeg' | 'pdf', scale: number, background: string): Promise<{ bytes: number[]; extension: string }> {
  if (!currentSvg) {
    return { bytes: [], extension: format };
  }
  const serializer = new XMLSerializer();
  const svgText = serializer.serializeToString(currentSvg);
  if (format === 'svg') {
    return { bytes: [...new TextEncoder().encode(svgText)], extension: 'svg' };
  }

  const bbox = currentSvg.viewBox.baseVal;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(bbox.width * scale));
  canvas.height = Math.max(1, Math.ceil(bbox.height * scale));
  const ctx = canvas.getContext('2d')!;
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const blob = new Blob([svgText], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Failed to rasterize'));
      img.src = url;
    });
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  } finally {
    URL.revokeObjectURL(url);
  }

  if (format === 'png' || format === 'jpeg') {
    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    const data = canvas.toDataURL(mime).split(',')[1];
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    return { bytes: [...bytes], extension: format === 'png' ? 'png' : 'jpg' };
  }

  const pngData = canvas.toDataURL('image/png').split(',')[1];
  const pngBytes = Uint8Array.from(atob(pngData), (c) => c.charCodeAt(0));
  const pdf = await PDFDocument.create();
  const embedded = await pdf.embedPng(pngBytes);
  const page = pdf.addPage([embedded.width, embedded.height]);
  page.drawImage(embedded, { x: 0, y: 0, width: embedded.width, height: embedded.height });
  const pdfBytes = await pdf.save();
  return { bytes: [...pdfBytes], extension: 'pdf' };
}

window.addEventListener('message', async (event) => {
  const msg = event.data;
  if (msg.type === 'graph') {
    currentGraph = msg.graph;
    currentCompareGraph = msg.compareGraph;
    currentParameters = msg.parameters ?? [];
    if (msg.detailLevel) {
      (document.getElementById('detail') as HTMLSelectElement).value = msg.detailLevel;
    }
    renderParameters();
    await render();
  }
  if (msg.type === 'export') {
    const background = msg.background ?? ((msg.format === 'jpeg' || msg.format === 'pdf') ? '#ffffff' : '');
    const result = await exportImage(msg.format, msg.scale ?? 2, background);
    vscode.postMessage({ type: 'exportResult', ...result });
  }
  if (msg.type === 'highlight') {
    const nodes = content.querySelectorAll('g[data-node-id]');
    nodes.forEach((n) => n.classList.remove('highlight'));
    const target = content.querySelector(`g[data-node-id="${CSS.escape(String(msg.nodeId))}"]`);
    target?.classList.add('highlight');
  }
});
