/**
 * Environment variable loading/typing.
 *
 * Wired into `ConfigModule.forRoot({ load: [configuration] })` (Step 4).
 *
 * Values are read from `process.env`, which `ConfigModule` has already validated
 * and normalised against `src/config/validation.schema.ts` before this factory
 * runs. That is why required values can be asserted as present and `PORT` is
 * already coerced from its string form to a number.
 */
export default function configuration() {
  return {
    nodeEnv: process.env.NODE_ENV ?? 'development',
    port: Number(process.env.PORT ?? 3000),

    /** PostgreSQL connection string consumed by Prisma. */
    database: {
      url: process.env.DATABASE_URL as string,
    },

    /** Redis connection string (BullMQ queues, rate limiting, idempotency keys). */
    redis: {
      url: process.env.REDIS_URL as string,
    },

    /** JWT signing configuration. */
    auth: {
      jwtSecret: process.env.JWT_SECRET as string,
    },

    /** Outbound SMS via Africa's Talking. */
    notifications: {
      africasTalking: {
        apiKey: process.env.AFRICASTALKING_API_KEY as string,
        username: process.env.AFRICASTALKING_USERNAME ?? 'sandbox',
      },
    },

    /** Error reporting. */
    sentry: {
      dsn: process.env.SENTRY_DSN as string,
      environment:
        process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    },

    /** AWS credentials + KMS key used to wrap Stellar secret seeds. */
    aws: {
      region: process.env.AWS_REGION as string,
      accessKeyId: process.env.AWS_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY as string,
      kmsKeyId: process.env.AWS_KMS_KEY_ID as string,
    },

    /** Stellar network selection. */
    stellar: {
      network: process.env.STELLAR_NETWORK as string,
      horizonUrl: process.env.STELLAR_HORIZON_URL as string,
    },
  };
}

