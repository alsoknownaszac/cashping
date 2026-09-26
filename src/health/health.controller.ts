import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ErrorResponseDto } from '../common/dto/error-response.dto.js';
import { HealthResponseDto } from './dto/health-response.dto.js';

/**
 * Liveness endpoint for the frontend, the container healthcheck and (later) a
 * load balancer.
 *
 * Sits under the same `/v1` route prefix as everything else (`/v1/health`), which
 * is the path the load balancer's health check is pointed at in the deployment
 * sequence - so it is a URL that has to stay put.
 *
 * No database or Redis call is made here, so a green response means "the API
 * process is up", not "every dependency is healthy".
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({
    summary: 'Is the API up?',
    description:
      'Returns as soon as the process can serve a request. No database or Redis call is made, so a green response means "the API is up", not "every dependency is healthy".',
  })
  @ApiOkResponse({
    type: HealthResponseDto,
    description: 'The API process is up and serving.',
  })
  @ApiResponse({
    status: 500,
    type: ErrorResponseDto,
    description:
      'Unexpected failure. Answered by the global exception filter in the shared error shape.',
  })
  check(): HealthResponseDto {
    return {
      status: 'ok',
      uptimeSeconds: Number(process.uptime().toFixed(3)),
      timestamp: new Date().toISOString(),
    };
  }
}
