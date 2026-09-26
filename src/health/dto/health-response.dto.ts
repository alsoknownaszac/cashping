import { ApiProperty } from '@nestjs/swagger';

/**
 * Liveness payload.
 *
 * Deliberately I/O-free: it answers "is this process up and serving", not "is
 * every dependency reachable" - those checks run at boot (see `main.ts`) and
 * report to the log. Keeping it I/O-free is what lets a poller hit it on a short
 * interval without touching Postgres or Redis.
 */
export class HealthResponseDto {
  @ApiProperty({
    description:
      'Always `ok`. A process that cannot serve a request produces no response at all, so there is no failure value to describe.',
    enum: ['ok'],
    example: 'ok',
  })
  status!: 'ok';

  @ApiProperty({
    description: 'Seconds since this process started.',
    example: 42.717,
  })
  uptimeSeconds!: number;

  @ApiProperty({
    description: 'ISO-8601 UTC server time when the request was handled.',
    example: '2026-09-26T10:00:00.000Z',
  })
  timestamp!: string;
}
