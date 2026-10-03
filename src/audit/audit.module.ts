import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuditService } from './audit.service.js';

/**
 * The audit trail (Step 32).
 *
 * ## Why this is not inside the ledger module
 *
 * `LedgerModule`'s docstring used to claim this module, and the claim has moved here because it
 * was wrong in a way that shows up in the import graph: `ledger/jobs` imports `WalletModule` (the
 * reconciliation sweep reads Horizon through `StellarService`), and the KMS decorator needs to
 * write audit entries. Audit inside `ledger/` would have meant `wallet → ledger/audit` and
 * `ledger/jobs → wallet`, which is a directory-level loop even though the *module* graph would
 * have stayed acyclic. Audit is a cross-cutting concern in the literal sense - every context
 * depends on it and it depends on none - and that is what earns it a top-level directory rather
 * than a place inside one of its consumers.
 *
 * ## What it is
 *
 * One provider and one method, over one table. `AuditService` has exactly one dependency
 * (`PrismaService`) and no exports beyond itself, which is what makes it safe to import from four
 * contexts: it cannot create a cycle, because there is nothing for it to import back.
 *
 * ## Who imports it
 *
 * - `IdentityModule` - `auth.otp.verified`, `auth.login`, `user.handle.set`;
 * - `PaymentsModule` - `payment.initiated`;
 * - `PaymentsQueueModule` - `payment.completed` and `payment.failed`, because the sweep that writes
 *   them (`PaymentsConfirmationService`) is provided there rather than in `PaymentsModule`; and
 * - `WalletModule` - the two `custody.key.*` actions, through `AuditedKeyWrapper`, which is bound
 *   over `KEY_WRAPPER` there.
 *
 * Each of those is a *one-way* import of a leaf: this module imports `PrismaModule` and nothing
 * else, so adding a fifth consumer - the reconciliation job is the obvious candidate, the day it
 * decides something worth recording - cannot create a cycle.
 *
 * `AuditModule` does not import `LedgerModule`, and must not: the reconciliation sweep's alerts
 * are Sentry events rather than audit entries, because a drift alert is a claim about *money* and
 * belongs where the on-call rotation already looks (`logger`/Sentry), while this table is the
 * record of what was *asked*. Two different readers, two different stores, and collapsing them
 * would make the audit trail a monitoring dashboard.
 */
@Module({
  imports: [PrismaModule],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
