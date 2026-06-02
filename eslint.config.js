import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/', 'scripts/', 'tests/fixtures/', 'tests/cloud/', 'tests/agent/', 'src/cloud/', 'src/agent/', 'packages/vscode-pgfence/'],
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/cloud/**', 'src/agent/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/cloud', '**/cloud/*', '**/cloud/**'], message: 'Cloud modules must not be imported from public code.' },
            { group: ['**/agent', '**/agent/*', '**/agent/**'], message: 'Agent modules must not be imported from public code.' },
          ],
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "ImportExpression[source.value=/^\\.\\.?\\/(?:cloud|agent)(?:\\/|$)/]",
          message: 'Local-only modules must not be dynamically imported from public code.',
        },
      ],
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
