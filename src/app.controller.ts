import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service.js';
import { ErrorResponseDto } from './common/dto/error-response.dto.js';

@ApiTags('app')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({
    summary: 'Greeting / service root',
    description:
      'A human-visible "the API is up" string. Also what the compose healthcheck polls, so its shape is kept stable.',
  })
  @ApiOkResponse({
    description:
      'The greeting, as `text/html` - Nest hands a returned string straight to Express, which sends it as HTML rather than JSON.',
    content: {
      'text/html': { schema: { type: 'string', example: 'Hello World!' } },
    },
  })
  @ApiResponse({
    status: 500,
    type: ErrorResponseDto,
    description:
      'Unexpected failure. Answered by the global exception filter in the shared error shape.',
  })
  getHello(): string {
    return this.appService.getHello();
  }
}
