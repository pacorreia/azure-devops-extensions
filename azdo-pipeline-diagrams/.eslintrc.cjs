module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  env: { node: true, es2022: true },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['dist/**', 'dist-ts/**'],
  overrides: [{ files: ['src/webview/**/*.ts'], env: { browser: true } }]
};
