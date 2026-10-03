import { Injectable, Logger } from '@nestjs/common';
import { type Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type AuditAction, type AuditOutcome } from './audit-events.js';

/**
 * One entry, as a caller supplies it.
 *
 * Everything but `action` is optional, because the points that write entries know different
 * amounts about what just happened: `auth.login` has the user and nothing else, and
 * `custody.key.wrapped` has an account id that may belong to a user row which has not been
 * written yet. Making the unknown fields explicit would push every caller into inventing a value.
 */
export interface AuditEntry {
  readonly action: AuditAction;
  /** The account this is about, when the caller has one. See `AuditLog.userId`. */
  readonly userId?: string;
  /** The row this is about: a payment id, a `stellar_accounts` id, a user id. */
  readonly subjectId?: string;
  /** `ok` for anything that happened, `failed` for an operation that did not. */
  readonly outcome?: AuditOutcome;
  /**
   * Identifiers and short codes - an amount, a ledger number, an error classification.
   *
   * **Never a secret, and never unbounded.** No OTP code, no phone number in the clear, no seed,
   * no data key, no signature, no raw provider response body. The rule has one reason: this table
   * is read by support and by whoever reviews an incident, and a table that contains secrets is a
   * table whose access has to be held as tightly as the secrets - which is the opposite of what an
   * audit trail is for.
   */
  readonly metadata?: Prisma.InputJsonValue;
}

/**
 * The one way an audit entry is written (Step 32).
 *
 * A service method called explicitly at each sensitive point, rather than an interceptor that
 * watches every request, and the difference is the whole of Step 32's requirement: an interceptor
 * can say "someone called `POST /v1/payments`", while this says "payment 6f0c… was created for
 * 12.5 USDC to recipient 91ab…" - because the caller that knows those things supplies them. A
 * generic interceptor would also record the endpoints that do not matter, and miss the ones that
 * do not go through HTTP at all, which is most of the interesting list: the confirmation sweep and
 * the KMS calls are not requests.
 *
 * ## The write is best-effort, and that is the decision rather than an oversight
 *
 * Every call site here is a money path or a custody path. If a failed insert could throw, an
 * audit-log outage - a full disk, a lock timeout, a dropped connection - would become a payments
 * outage, and the cheapest fix available to whoever is on call would be to delete the audit call.
 * So the insert is attempted, a failure is logged *with the action name and no payload*, and the
 * caller carries on. What that buys is a sensitive path that cannot be taken down by its own
 * bookkeeping. What it costs is stated plainly: the entry is lost, and the gap is invisible in the
 * table - there is a line in the process log and nothing in the data.
 *
 * ## Append-only is enforced by the database, and is not the same as tamper-evident
 *
 * This class only ever calls `create`, and the table takes no `UPDATE` and no `DELETE` from anyone
 * (see the migration's trigger). So a row that exists is a row as written, and no code path -
 * including a future one, including this app's own migrations - can rewrite history through the
 * database the app connects with.
 *
 * It is still not tamper-*evident*, and the distinction is worth being exact about: nothing here
 * would reveal that a row had been removed by someone who could disable the trigger or run
 * `TRUNCATE`. Closing that needs the entries to be chained - each row carrying a hash of the
 * previous one, with the head published somewhere the database cannot reach - which is a different
 * build, for a compliance regime this app is not under. Writing half of it (a sequence number, say)
 * would only make the log *look* verifiable.
 *
 * ## What would make the write mandatory
 *
 * If the trail ever becomes a regulatory artefact, the change is to write the entry in the *same*
 * database transaction as the thing it describes, so the payment and its audit row commit or roll
 * back together. That is a real option and it is deliberately not taken here: this step's call
 * sites are spread across four contexts, two of them write outside any transaction (the sweep's
 * compare-and-set, the KMS decorator), and a version that awaited the insert but still swallowed
 * failures would buy the latency of the mandatory design and the guarantee of neither.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Appends one entry. Never throws - see the class docstring for why that is the design.
   *
   * The method is `async` and every call site `await`s it: a fire-and-forget insert would be an
   * unhandled rejection waiting for the first database problem, and the round trip it costs is one
   * statement against a table nothing reads during a request. It is not in a transaction with the
   * caller's work either way, so awaiting it cannot make the caller's own write fail.
   */
  async log(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: entry.action,
          userId: entry.userId ?? null,
          subjectId: entry.subjectId ?? null,
          outcome: entry.outcome ?? null,
          // Spread rather than `metadata: entry.metadata ?? null`, because Prisma reads a bare
          // `null` for a nullable `Json` column as the JSON value `null` - a row whose metadata is
          // the four bytes `null` is a row that claims to have metadata, and "not provided" has to
          // keep the one representation it has everywhere else in this schema.
          ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
        },
      });
    } catch (error) {
      this.logger.error(
        `Audit entry ${entry.action} could not be written - ${
          error instanceof Error ? error.message : 'unknown failure'
        }`,
      );
    }
  }
}
