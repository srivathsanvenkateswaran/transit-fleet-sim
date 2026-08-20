import { defineConfig } from 'vitest/config'

// `include` is explicit rather than left to the default glob. The default
// walks upward far enough to pick up sibling checkouts when this repo sits
// beside others, and a suite that silently runs another project's tests
// reports failures nobody can act on.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', 'data/**'],
    // e2e needs the container up. Opt in with `vitest --mode e2e`.
    testTimeout: 15_000,
  },
})
