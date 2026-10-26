// ESLint flat config: the recommended sets plus the rules STYLEGUIDE.md names with a "Lint:" line.
// The tree is JavaScript today, so the rules that only make sense on type syntax (consistent-type-imports,
// consistent-type-definitions, array-type, the enum selector) are scoped to .ts files, where they can fire on
// real type syntax. Type-aware rules (recommendedTypeChecked, switch-exhaustiveness-check) run on .js too because
// tsconfig has checkJs. Existing violations live in eslint-suppressions.json and may only shrink.

import js from '@eslint/js';
import globals from 'globals';
import { importX } from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

import { plugin as testRules } from './tools/eslint-test-rules.mjs';

const code = ['**/*.js', '**/*.mjs', '**/*.ts'];
const typeSyntax = ['**/*.ts'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '.agents/**',
      'data/**',
      'references/**',
      'prompts.local/**',
      'tools/fixtures/**',
      '.claude/**',
      '.opencode/**',
    ],
  },
  {
    files: code,
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'import-x': importX },
    rules: {
      'import-x/no-default-export': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': 'allow-with-description' }],
    },
  },
  {
    // The config file sits outside tsconfig's include, so it gets the syntax-only rules.
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
    // ESLint reads the config through its default export.
    rules: { 'import-x/no-default-export': 'off' },
  },
  {
    // node:test's test() and describe() return promises that the runner collects. Awaiting each one is not
    // wanted, so the rule would fire on every test file.
    files: ['tests/**/*.js', 'tests/**/*.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
  {
    // The test method of AGENTS.md (section Tests), as rules from tools/eslint-test-rules.mjs.
    files: ['tests/**/*.js', 'tests/**/*.ts'],
    plugins: { tests: testRules },
    rules: {
      'tests/assertion-in-test': 'error',
      'tests/no-presence-assertion': 'error',
      'tests/no-wide-deep-equal': 'error',
    },
  },
  {
    files: typeSyntax,
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/array-type': ['error', { default: 'generic' }],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: 'Replace enum with a literal type or a const assertion.' },
      ],
    },
  }
);
