import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';

/**
 * Liveness endpoint.
 *
 * Not a bounded context like the modules alongside it: it exists so the frontend
 * and any poller have one cheap, stable URL to check.
 */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
