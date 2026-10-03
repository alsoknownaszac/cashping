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
    // A hook here does that *and* the file's own fixtures: `recipients.e2e-spec.ts`
    // boots the app, registers four accounts through HTTP and settles its own rows
    // before its first test runs. With a dozen files booting the same app at once
    // that overran vitest's 10s default - and then 30s - on a loaded machine while
    // every test in the file passed once the hook was given room. This is the
    // biggest hook in the suite, so it sets the number; the hooks that need less say
    // so themselves (`audit` passes 90s to a hook that also sweeps).
    hookTimeout: 90_000,
  },
});
