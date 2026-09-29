import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ApiErrorResponses } from '../../common/http/swagger.js';
import { CurrentUser } from '../../identity/jwt/current-user.decorator.js';
import { JwtAuthGuard } from '../../identity/jwt/jwt-auth.guard.js';
import { type SessionUser } from '../../identity/token/token.service.js';
import { RecipientConfirmationResponseDto } from '../dto/recipient-confirmation-response.dto.js';
import { RecipientSearchResponseDto } from '../dto/recipient-search-response.dto.js';
import { SearchRecipientsQueryDto } from '../dto/search-recipients.dto.js';
import { RecipientsService } from '../services/recipients.service.js';

/**
 * The recipient directory over HTTP (Steps 21 and 22): `GET /v1/recipients/search` and
 * `GET /v1/recipients/:id`.
 *
 * These two routes are what makes a payment possible at all: the frontend has to turn what
 * someone typed into an account id, then confirm that the id is the right person, and only then
 * ask for an amount (Step 25). The first route is the one that can be swept, so it is the one
 * with a rate limit - `/v1/recipients/:id` is guarded too, on the same allowance, because a
 * lookup is a lookup (`RecipientLookupRateLimiter`).
 *
 * ## `search` has to be declared before `:id`
 *
 * Nest registers routes in the order the methods appear, and `/recipients/search` also matches
 * `/recipients/:id`. Declared the other way round, `search` would arrive as an `:id` and be
 * refused by the UUID pipe with a 400 - a working route that reads like a validation bug. The
 * order below is the fix, and it is invisible unless someone reorders these methods.
 *
 * ## The guard and the user are identity's, as in `WalletController`
 *
 * `JwtAuthGuard` and `@CurrentUser` are imported as files from `src/identity/jwt`, not through
 * `IdentityModule`: `PaymentsModule` deliberately does not import identity (the guard has no
 * constructor dependencies, and the `jwt` strategy it resolves by name is registered once, by
 * `IdentityModule`, in the app graph this controller is served from). A second guard would be a
 * second definition of what an access token means.
 *
 * ## Every handler is one delegation
 *
 * `RecipientsService` owns the logic and the status codes (400 for a `q` that is neither a
 * number nor a handle prefix, 404 for an id that is not a payable recipient, 429/503 from the
 * lookup limit). Nothing here knows what a `users` row is.
 */
@ApiTags('recipients')
@Controller('recipients')
export class RecipientsController {
  constructor(private readonly recipients: RecipientsService) {}

  @Get('search')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Find someone to pay by phone number or handle',
    description: [
      '`q` is read as a phone number first (through the Step 9 normalizer, so any format works) and as a handle prefix second.',
      '',
      'A phone number is matched **exactly** and returns at most one account: a partial number is not a search. A handle is matched by prefix, so `mir` finds `miriam_owusu` - the one half of this endpoint that lists people.',
      '',
      'Results never include a phone number, and never include the caller: see `RecipientSearchResultDto` for why the number is not disclosed to a directory lookup, and what adding it would cost.',
      '',
      'This is the most enumerable endpoint in the API (a registered number answers with a person, an unregistered one with nothing), so lookups are capped per caller. A 429 means the allowance for the current window is spent; the message says how long to wait.',
    ].join('\n'),
  })
  @ApiQuery({ name: 'q', required: true, type: String })
  @ApiOkResponse({
    type: RecipientSearchResponseDto,
    description:
      'Zero or more recipients, plus which reading of `q` produced them. Finding nobody is a 200 with an empty list, not a 404.',
  })
  @ApiErrorResponses([
    {
      status: 400,
      description:
        '`q` is empty, is not a usable handle prefix (too short, too long, illegal characters), or `limit` is out of range.',
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
        'The caller has spent the recipient lookup allowance for this window. The message says how many seconds to wait.',
    },
    {
      status: 503,
      description:
        'The lookup limit could not be evaluated (Redis unreachable), so the search was refused rather than run uncounted. Retry shortly.',
    },
  ])
  search(
    @CurrentUser() user: SessionUser,
    @Query() query: SearchRecipientsQueryDto,
  ): Promise<RecipientSearchResponseDto> {
    return this.recipients.search(user.id, query);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Confirm who an account id belongs to before paying it',
    description: [
      "The confirmation screen's payload: the handle, the display name, and whether the identity behind the account is verified. Nothing more - no phone number, no wallet, no key.",
      '',
      'Only accounts that can receive money are described: an unverified, suspended or unknown id all answer 404, deliberately without saying which, because "this id exists but is suspended" is not something the screen needs to know.',
      'Passing your own id is allowed and answers about yourself, so the confirmation component is the same one for "this is you".',
    ].join('\n'),
  })
  @ApiParam({
    name: 'id',
    description: 'The account id - from a search result, not a handle.',
    example: '0f8fad5b-d9cb-469f-a165-70867728950e',
  })
  @ApiOkResponse({
    type: RecipientConfirmationResponseDto,
    description: 'The recipient is verified and able to receive money.',
  })
  @ApiErrorResponses([
    { status: 400, description: '`id` is not a UUID, so it cannot be an account id.' },
    {
      status: 401,
      description:
        'No `Authorization: Bearer <token>` header, or the token is expired, malformed, or not one this API signed. Refresh, then sign in again if that fails.',
    },
    { status: 403, description: 'The account is suspended.' },
    {
      status: 404,
      description:
        'No payable recipient has that id: it does not exist, or the account behind it is not verified or is suspended.',
    },
    {
      status: 429,
      description: 'The caller has spent the recipient lookup allowance for this window.',
    },
    {
      status: 503,
      description:
        'The lookup limit could not be evaluated (Redis unreachable), so the lookup was refused rather than run uncounted.',
    },
  ])
  confirm(
    @CurrentUser() user: SessionUser,
    // The pipe is what turns "not a UUID" into a 400 here rather than into a 404 from the
    // database: an id that cannot be an id is a malformed request, and the two answers mean
    // different things to a client (fix the request, versus stop looking).
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<RecipientConfirmationResponseDto> {
    return this.recipients.confirm(user.id, id);
  }
}
