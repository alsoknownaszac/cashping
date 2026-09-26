import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // The same headroom as the unit config, for a different reason: each of these
    // boots the whole application (config validation, Prisma, Redis) and the auth
    // flow then derives an scrypt hash per OTP, so a loaded machine can push a
    // single test past the 5s default.
    testTimeout: 15_000,
  },
});
