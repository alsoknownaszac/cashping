/**
 * class-validator schema for environment variables.
 *
 * Populated in Step 4 (Environment configuration), once `@nestjs/config`,
 * `class-validator` and `class-transformer` are installed, so that the app
 * refuses to boot when a required variable is missing rather than failing
 * mysteriously later.
 */
export const validationSchema: Record<string, unknown> = {};
