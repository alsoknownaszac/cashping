-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "failure_reason" TEXT,
ADD COLUMN     "stellar_tx_hash" TEXT,
ADD COLUMN     "stellar_tx_sequence" VARCHAR(20),
ADD COLUMN     "submission_deadline" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "transactions_stellar_tx_hash_key" ON "transactions"("stellar_tx_hash");
