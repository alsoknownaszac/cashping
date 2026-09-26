import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // 5s (the default) is not enough headroom for the OTP specs on a loaded
    // machine: scrypt hashing is deliberately expensive (~16MB per derivation) and
    // a busy laptop stretched a 1.2s spec past 11s the first time these were run.
    // 15s still fails loudly on a genuine hang.
    testTimeout: 15_000,
  },
});
