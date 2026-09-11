import esbuild from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));
const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  sourcemap: true,
  minify: false,
  target: 'es2022',
  external: ['vscode'],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production')
  }
};

const extensionConfig = {
  ...common,
  platform: 'node',
  format: 'cjs',
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js'
};

const webviewConfig = {
  ...common,
  platform: 'browser',
  format: 'iife',
  globalName: 'AzdoDiagramWebview',
  entryPoints: ['src/webview/main.ts'],
  outfile: 'dist/webview.js',
  external: []
};

if (watch) {
  const [extCtx, webCtx] = await Promise.all([esbuild.context(extensionConfig), esbuild.context(webviewConfig)]);
  await Promise.all([extCtx.watch(), webCtx.watch()]);
  console.log(`${pkg.name} watch mode started`);
} else {
  await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
}
