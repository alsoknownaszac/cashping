import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type CountryCode } from 'libphonenumber-js';
import { UserStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RecipientConfirmationResponseDto } from '../dto/recipient-confirmation-response.dto.js';
import {
  RecipientSearchResponseDto,
  RecipientSearchResultDto,
} from '../dto/recipient-search-response.dto.js';
import { type SearchRecipientsQueryDto } from '../dto/search-recipients.dto.js';
import {
  RECIPIENT_SEARCH_DEFAULT_LIMIT,
  classifyRecipientQuery,
  UnsearchableQueryError,
  unsearchableQueryMessage,
  type RecipientQuery,
} from '../recipients/recipient-query.js';
import {
  RecipientLookupRateLimiter,
  RecipientLookupRateLimitExceededError,
  RecipientLookupRateLimitUnavailableError,
} from './recipient-lookup-rate-limiter.service.js';

/**
 * The columns a search may read. Named here so that "what this endpoint discloses" is a list in
 * one file rather than a habit spread over two queries - and so that the absence of
 * `phoneNumber` is something a reviewer can see, which is the first line of Step 21's audit.
 */
const SEARCH_COLUMNS = { id: true, handle: true, displayName: true } as const;

/**
 * The columns that decide whether an account can be paid, plus the one fact `verified` is
 * derived from. Still no `phoneNumber`, still no key material, still nothing a screen showing
 * "who am I about to pay" has to have.
 */
const PAYABLE_COLUMNS = {
  id: true,
  handle: true,
  displayName: true,
  phoneVerifiedAt: true,
} as const;

/**
 * What makes an id a *payable recipient*, in one place for the two readers of that question.
 *
 * `GET /v1/recipients/:id` (Step 22) confirms an id before the client asks for an amount, and
 * `POST /v1/payments` (Step 25) is the write that spends the money - and both have to answer
 * "may this account be paid" the same way, or a client can confirm somebody it cannot pay. The
 * filter is stated rather than left as a habit in one query so that a change is a change to
 * both paths.
 *
 * Both conditions, not just the status: `verified` on the confirmation response is derived
 * from `phoneVerifiedAt`, and filtering on `ACTIVE` alone would offer a row that is active but
 * unverified (reachable by a direct write, a half-finished verification, or a future admin
 * action) as a payee with `verified: false`. An account with no confirmed phone number is not
 * a payee.
 */
const PAYABLE_RECIPIENT_FILTER = {
  status: UserStatus.ACTIVE,
  phoneVerifiedAt: { not: null },
} as const;

/** One directory row, as either query selected it. */
interface RecipientRow {
  readonly id: string;
  readonly handle: string | null;
  readonly displayName: string | null;
}

/**
 * A recipient a payment may be sent to: a directory row plus the timestamp `verified` is
 * derived from. Exported because Step 25's creation path asks the same question through
 * `assertPayableRecipient` and needs the row it answers with.
 */
export interface PayableRecipient extends RecipientRow {
  readonly phoneVerifiedAt: Date | null;
}

/**
 * The recipient directory (Steps 21 and 22): who a payment could be sent to, and whether the
 * person on the confirmation screen is that account.
 *
 * ## Two endpoints, two questions, and the differences between them are the design
 *
 * `search` answers "who might this be" from a typed phone number or handle, and returns a list.
 * `confirm` answers "is this the account I am about to pay" from an id, and returns one row.
 * Neither reads a wallet, a balance or a Stellar key: what this service owns is *identity*, and
 * whether a recipient can actually receive USDC right now is a question for Horizon (Step 20's
 * balance endpoint is where that answer lives).
 *
 * ## Only `ACTIVE` accounts are recipients
 *
 * A `PENDING_VERIFICATION` account has a phone number and no proof of it, and no wallet; a
 * `SUSPENDED` one may not transact. Returning either from a directory lookup would offer a payee
 * that cannot be paid, so both are filtered in the query (not in a mapper afterwards, where a
 * future call path could forget). This is also why `verified` is `true` on every confirmation
 * response - it is derived from `phoneVerifiedAt`, and no row without it reaches the DTO.
 *
 * ## The caller never appears in a search, and may confirm themselves
 *
 * `search` excludes the caller: it is the surface someone sweeps, and its answer is a list of
 * *other* people to pay, so offering yourself in it would be noise at best. `confirm` does not,
 * because it answers about an id the caller already holds (from a search result, or from
 * `GET /auth/session`); refusing to describe the caller's own account there would make the
 * frontend's confirmation component unusable for "this one is you". The asymmetry is the point,
 * not an oversight.
 *
 * ## Both endpoints spend the same allowance
 *
 * The lookup counter (`RecipientLookupRateLimiter`) is consumed before any query runs, so a
 * swept miss costs as much as a hit - see that class for why the enumeration limit exists.
 */
@Injectable()
export class RecipientsService {
  private readonly logger = new Logger(RecipientsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimiter: RecipientLookupRateLimiter,
    private readonly config: ConfigService,
  ) {}

  /**
   * `GET /v1/recipients/search` (Step 21).
   *
   * One reading of `q`, two queries, and the reading decides which - a phone number is an
   * equality on a unique column, a handle is a bounded prefix range. `hasMore` is computed by
   * asking for one row past the limit rather than by a second `count()`, so the answer cannot
   * disagree with the page the client is looking at.
   */
  async search(
    callerId: string,
    dto: SearchRecipientsQueryDto,
  ): Promise<RecipientSearchResponseDto> {
    // Counted before the query, so a sweep is priced even where it finds nothing - which is
    // exactly the case the limit exists for: "not registered" is the answer being bought.
    await this.assertWithinLookupLimit(callerId);

    const query = this.classify(dto.q);
    const limit = dto.limit ?? RECIPIENT_SEARCH_DEFAULT_LIMIT;

    if (query.kind === 'phone') {
      /**
       * `findFirst` rather than `findUnique`, although `phone_number` is unique: what is being
       * matched is (number, ACTIVE, not the caller), and only a unique *column* fits
       * `findUnique`'s `where`. The uniqueness of the number is what still makes this return at
       * most one row.
       */
      const recipient = await this.prisma.user.findFirst({
        where: {
          phoneNumber: query.phoneNumber,
          status: UserStatus.ACTIVE,
          id: { not: callerId },
        },
        select: SEARCH_COLUMNS,
      });

      return {
        matchedBy: 'phone',
        results: recipient === null ? [] : [toSearchResult(recipient)],
        hasMore: false,
      };
    }

    /**
     * The prefix match needs no `mode: 'insensitive'` and no functional index: every handle is
     * stored in canonical lower case (Step 15), so `startsWith` *is* the case-insensitive match,
     * on the plain unique index. The `+ 1` is the whole of `hasMore`.
     */
    const rows = await this.prisma.user.findMany({
      where: {
        handle: { startsWith: query.prefix },
        status: UserStatus.ACTIVE,
        id: { not: callerId },
      },
      select: SEARCH_COLUMNS,
      orderBy: { handle: 'asc' },
      take: limit + 1,
    });

    return {
      matchedBy: 'handle',
      results: rows.slice(0, limit).map(toSearchResult),
      hasMore: rows.length > limit,
    };
  }

  /**
   * `GET /v1/recipients/:id` (Step 22): the confirmation view for one account.
   *
   * The caller's id is used for the allowance and for nothing else - see the class docstring on
   * why confirming *yourself* is allowed while searching for yourself is not.
   *
   * A 404 covers three cases on purpose: an id nothing holds, a suspended account, and an
   * unverified one. They are the same answer to the question this endpoint is asked ("is this
   * someone I can pay"), and telling them apart would make the endpoint a probe for which ids
   * exist and what state they are in - more than a confirmation screen needs to know.
   */
  async confirm(callerId: string, id: string): Promise<RecipientConfirmationResponseDto> {
    await this.assertWithinLookupLimit(callerId);

    const recipient = await this.assertPayableRecipient(id);

    return {
      id: recipient.id,
      handle: recipient.handle,
      displayName: recipient.displayName,
      // `!== null` rather than a truthy check: the column is a Date, and the explicit form is
      // the one that cannot start lying if it ever holds something else. It is `true` on every
      // response that gets here, because the filter above requires the timestamp - the
      // comparison stays because it is the derivation, not a constant.
      verified: recipient.phoneVerifiedAt !== null,
    };
  }

  /**
   * The account behind `id` if money may be sent to it, or a 404 - the one definition of
   * "payable", shared with Step 25's creation path (`PaymentsService`).
   *
   * No allowance is spent here, deliberately: the lookup limit prices *sweeping the directory*
   * (see `RecipientLookupRateLimiter`), and a payment's own recipient check is not a sweep - it
   * is the second half of one confirmed payment, already paid for by the confirmation read.
   * Charging it twice would cap a client at ten payments a minute for a reason that has nothing
   * to do with payments.
   *
   * The 404 is the same sentence for an id that does not exist, an account that is suspended
   * and an account that is unverified: they are one answer to the question this is asked ("may
   * I pay this"), and telling them apart is what would make it a probe. `confirm` above and the
   * payment path below both read that sentence from here, so the two cannot drift into two
   * different accounts of the same refusal.
   */
  async assertPayableRecipient(id: string): Promise<PayableRecipient> {
    const recipient: PayableRecipient | null = await this.prisma.user.findFirst({
      where: { id, ...PAYABLE_RECIPIENT_FILTER },
      select: PAYABLE_COLUMNS,
    });

    if (recipient === null) {
      throw new NotFoundException(
        'No Cashping account with that id can receive money. Check the id, or search again.',
      );
    }

    return recipient;
  }

  /** Reads `q`, or refuses it with the rule it broke. */
  private classify(q: string): RecipientQuery {
    // The region only decides how a *local* spelling is read (`024 123 4567`), and it is the
    // same configuration `AuthService` normalizes registration against: one answer to "which
    // country is this number in", not two. The cast is the one `AuthService` makes as well, for
    // the same reason - `validation.schema.ts` checked the shape and `configuration()` uppercased
    // it, so this states a fact rather than hoping for one.
    const defaultRegion = this.config.getOrThrow<string>('phone.defaultRegion') as CountryCode;

    try {
      return classifyRecipientQuery(q, defaultRegion);
    } catch (error) {
      if (error instanceof UnsearchableQueryError) {
        throw new BadRequestException(unsearchableQueryMessage(error.reason));
      }

      throw error;
    }
  }

  /**
   * Counts a lookup against the caller's allowance, or refuses.
   *
   * The same two mappings `AuthService.assertWithinRequestLimit` uses, for the same reasons: over
   * the limit is a 429 with the wait in the message (the client can show a countdown), and a Redis
   * that cannot be reached is a 503 whose detail stays in the log - never a lookup that proceeds
   * uncounted.
   */
  private async assertWithinLookupLimit(callerId: string): Promise<void> {
    try {
      await this.rateLimiter.consume(callerId);
    } catch (error) {
      if (error instanceof RecipientLookupRateLimitExceededError) {
        const seconds = error.retryAfterSeconds;

        throw new HttpException(
          `Too many recipient lookups. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      if (error instanceof RecipientLookupRateLimitUnavailableError) {
        throw new ServiceUnavailableException(
          'Recipient search is temporarily unavailable. Please try again in a moment.',
        );
      }

      throw error;
    }
  }
}

/**
 * The one place a row becomes a response.
 *
 * It reads two columns plus the id, and `phoneNumber` is not one of them - which is why this
 * function cannot leak a number even if the DTO is later edited to ask for one: the column would
 * have to be added to the `select` as well, and that is the line a reviewer is looking at.
 */
function toSearchResult(row: RecipientRow): RecipientSearchResultDto {
  return { id: row.id, handle: row.handle, displayName: row.displayName };
}
