import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HANDLE_MAX_LENGTH, HANDLE_MIN_LENGTH } from '../../identity/handle/handle.js';
import { ApiErrorResponses } from '../../common/http/swagger.js';
import { CurrentUser } from '../../identity/jwt/current-user.decorator.js';
import { JwtAuthGuard } from '../../identity/jwt/jwt-auth.guard.js';
import { type SessionUser } from '../../identity/token/token.service.js';
import {
  HandleAvailabilityQueryDto,
  HandleAvailabilityResponseDto,
} from '../dto/handle-availability.dto.js';
import { HandlesService } from '../services/handles.service.js';

/**
 * The handle claim check over HTTP: `GET /v1/handles/availability`.
 *
 * ## Why this lives in `PaymentsModule`
 *
 * A handle is *identity* - `handle.ts` and the rules that own it are identity's - but the question
 * this route answers is the payment one: "is this name free for someone to be paid at". The
 * directory endpoints already read the `users` table here for the same reason
 * (`RecipientsService`), and the allowance this route spends is the directory's
 * (`RecipientLookupRateLimiter`), so the module that owns "who may be paid" is where a caller
 * asking about a name belongs. `PaymentsModule` reaches identity the way it already does for the
 * guard and the rules: as *files*, not through `IdentityModule`.
 *
 * ## The guard is identity's, as in `RecipientsController`
 *
 * `JwtAuthGuard` and `@CurrentUser` are imported as files from `src/identity/jwt`, not through
 * `IdentityModule` (that boundary is unchanged - see `PaymentsModule`): the guard has no
 * constructor dependencies, and the `jwt` strategy it resolves by name is registered once, by
 * `IdentityModule`, in the app graph this controller is served from. A second guard would be a
 * second definition of what an access token means.
 *
 * ## One handler, one delegation
 *
 * `HandlesService` owns the logic and the status codes (400 for a handle that is not a handle,
 * 429/503 from the lookup allowance). Nothing here knows what a `users` row is, and nothing here
 * restates a handle rule - the ceiling below is imported from `handle.ts`.
 */
@ApiTags('handles')
@Controller('handles')
export class HandlesController {
  constructor(private readonly handles: HandlesService) {}

  @Get('availability')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Check whether a handle is free to claim',
    description: [
      `Answers the question a signup or rename field asks before it is submitted: could this account claim this handle? The handle is checked against the rules registration applies (${HANDLE_MIN_LENGTH}-${HANDLE_MAX_LENGTH} characters of letters, digits and underscores, \`@\` stripped, matched lower-cased) and then against the accounts that hold one.`,
      '',
      'A handle that breaks a rule is a **400**, in the same words registration would refuse it, so a client can tell "fix the input" from "try another name": everything that reaches the body with a 200 is a *well-formed* handle.',
      '',
      'A 200 answers `{ handle, available }`, where `handle` is the canonical form that was checked and `available` is `false` only when **another** account holds it. The caller’s own current handle answers `true` - re-submitting the name you already hold is not a conflict.',
      '',
      'This is an **advisory** read, not a reservation: two callers can both be told `true` in the same instant, and the unique index on the column decides when one of them claims it.',
      '',
      'Like `/recipients/search`, this endpoint spends the caller\'s lookup allowance, because it answers the same kind of question - "does this resolve to an account" - one name at a time.',
    ].join('\n'),
  })
  @ApiOkResponse({
    type: HandleAvailabilityResponseDto,
    description: 'The canonical handle, and whether the caller could claim it right now.',
  })
  @ApiErrorResponses([
    {
      status: 400,
      description:
        'The handle is empty, too short, too long, contains an illegal character, or is reserved. The message names the rule that broke.',
    },
    {
      status: 401,
      description:
        'No `Authorization: Bearer <token>` header, or the token is expired, malformed, or not one this API signed. Refresh, then sign in again if that fails.',
    },
    { status: 403, description: 'The account is suspended.' },
    {
      status: 429,
      description:
        'The caller has spent the lookup allowance for this window. The message says how many seconds to wait.',
    },
    {
      status: 503,
      description:
        'The lookup limit could not be evaluated (Redis unreachable), so the check was refused rather than run uncounted. Retry shortly.',
    },
  ])
  check(
    @CurrentUser() user: SessionUser,
    @Query() query: HandleAvailabilityQueryDto,
  ): Promise<HandleAvailabilityResponseDto> {
    return this.handles.checkAvailability(user.id, query);
  }
}
