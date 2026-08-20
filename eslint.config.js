import babelParser from '@babel/eslint-parser'

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: { plugins: [['@babel/plugin-syntax-typescript', { isTSX: false }]] },
      },
    },
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Use the keyed seeded generator in src/sim/rand.ts.',
        },
      ],
    },
  },
]
