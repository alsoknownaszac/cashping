import { Module } from '@nestjs/common';
import { LedgerQueueModule } from './jobs/ledger-queue.module.js';

/**
 * Ledger bounded context (reconciliation).
 *
 * Step 31 gives this module its first contents: the reconciliation sweep, which compares the sum of
 * the app's own recorded movements for each account against what Horizon reports, and reports any
 * drift. The sweep lives in `jobs/` (the queue and its worker) and `services/` (the comparison), and
 * `LedgerQueueModule` exports the seam that fires one tick on demand.
 *
 * Step 32 adds the append-only audit log, which lives in `src/audit/` rather than here: it is a
 * cross-cutting concern - identity, payments and the wallet all write to it, and it imports none of
 * them - and putting it in this directory would have created a `wallet → ledger` and
 * `ledger → wallet` import loop, since the reconciliation sweep already reaches the wallet for
 * Horizon. `AuditModule`'s docstring records that move.
 */
@Module({
  imports: [LedgerQueueModule],
})
export class LedgerModule {}

