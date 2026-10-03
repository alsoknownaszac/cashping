import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { WalletModule } from '../../wallet/wallet.module.js';
import { ReconciliationService } from '../services/reconciliation.service.js';
import { LEDGER_QUEUE } from './ledger-queue.js';
import { LedgerQueueService } from './ledger-queue.service.js';
import { LedgerProcessor } from './ledger.processor.js';

/**
 * Everything about the ledger queue that is not reconciliation logic (Step 31): the queue itself, the
 * worker that drains it, and the one service that puts a job on it.
 *
 * A module of its own rather than a handful of imports in `LedgerModule`, mirroring
 * `PaymentsQueueModule`: the dependency only ever points one way - this file knows nothing about
 * ledger controllers or DTOs - so nothing here can grow into them.
 *
 * ## The connection is inherited, not described
 *
 * `BullModule.registerQueue` and nothing else. `forRootAsync` is the shared configuration for every
 * queue in the process (`forRoot` is `global: true` in `@nestjs/bullmq`), and
 * `PaymentsQueueModule` already describes that one connection - exactly as its docstring says it
 * would for Step 31. This module inherits it rather than describing a second one, so both queues
 * cannot drift onto different Redis servers.
 *
 * ## Why `WalletModule` is imported
 *
 * For the two things a comparison needs from the network: `StellarService` (the app's one door to
 * Horizon, including the balance read) and `UsdcTrustlineService` (the one definition of which asset
 * a wallet is paid in). Both are exported by `WalletModule`; nothing else here reaches into the
 * wallet, and the wallet knows nothing about the ledger.
 */
@Module({
  imports: [BullModule.registerQueue({ name: LEDGER_QUEUE }), PrismaModule, WalletModule],
  providers: [LedgerQueueService, ReconciliationService, LedgerProcessor],
  /**
   * `LedgerQueueService` is exported so a test (and an operator's script) can fire one sweep on
   * demand with `enqueueReconciliation()`, the same seam `PaymentsQueueModule` exports its queue
   * service for.
   */
  exports: [LedgerQueueService],
})
export class LedgerQueueModule {}
