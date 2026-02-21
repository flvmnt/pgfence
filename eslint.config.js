import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ['dist/', 'scripts/', 'tests/fixtures/', 'tests/cloud/', 'src/cloud/', 'src/agent/'],
  },
  {
    files: ['src/**/*.ts'],
    ignores: ['src/cloud/**', 'src/agent/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/cloud/*', '**/cloud/**'], message: 'Cloud modules must not be imported from public code.' },
            { group: ['**/agent/*', '**/agent/**'], message: 'Agent modules must not be imported from public code.' },
          ],
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
