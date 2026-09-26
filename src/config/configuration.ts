/**
 * Environment variable loading/typing.
 *
 * Wired into `ConfigModule.forRoot({ load: [configuration] })` in Step 4
 * (Environment configuration). Deliberately dependency-free until then, so the
 * app compiles and boots before `@nestjs/config` is installed.
 */
export default function configuration() {
  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 3000),
  };
}
