-- Step 18: the Stellar account row that holds encrypted key material.
--
-- Prisma wrote this file; the only hand-written part is this header. It is kept
-- because the two decisions below are not visible from the DDL alone.
--
-- 1. `encrypted_secret_key` is a `cp-kms-1` envelope, never a seed. Its shape is
--    `<version>.<wrapped data key>.<iv>.<tag>.<ciphertext>` and it is unreadable
--    without a KMS `Decrypt` call, which is what the Step 18 audit verifies by
--    reading this table directly rather than through the API. Nothing else in the
--    row is secret: `public_key` is public by definition and `data_key_arn` is a
--    key reference, not key material.
--
-- 2. `ON DELETE RESTRICT` on `user_id`, deliberately unlike the `CASCADE` the auth
--    tables use. Deleting a user must not destroy sealed key material or orphan a
--    funded Stellar account, so the database refuses the delete until the account
--    has been dealt with explicitly. That is a fail-closed default: a deletion path
--    written later cannot forget, because it will get an error instead of silently
--    succeeding.
--
-- No data migration: the table starts empty, and nothing that exists today
-- references it. Every account created from here on is created through
-- `SeedCustodyService`, which is the only code that writes these columns.

-- CreateTable
CREATE TABLE "stellar_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "public_key" TEXT NOT NULL,
    "encrypted_secret_key" TEXT NOT NULL,
    "data_key_arn" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stellar_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stellar_accounts_user_id_key" ON "stellar_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "stellar_accounts_public_key_key" ON "stellar_accounts"("public_key");

-- AddForeignKey
ALTER TABLE "stellar_accounts" ADD CONSTRAINT "stellar_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
