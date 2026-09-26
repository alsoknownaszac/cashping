-- Step 8: finalize the User model for phone-first registration + OTP.
--
-- `PENDING` is *renamed* rather than dropped and re-added. It is the same account
-- state under a more explicit name, so a rename preserves the meaning of every
-- existing row; Prisma's generated form of this change (CREATE new enum, cast,
-- DROP old enum) fails outright on a non-empty table, and there is no reason to
-- depend on this table happening to be empty.
--
-- This migration was written by hand for that reason and applied with
-- `prisma migrate deploy` (the CLI's interactive "are you sure" for a removed
-- enum variant cannot be answered in a non-interactive run). `npx prisma migrate
-- diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma
-- --exit-code` reports no drift afterwards, which is what confirms this SQL and
-- `schema.prisma` still agree.

ALTER TYPE "UserStatus" RENAME VALUE 'PENDING' TO 'PENDING_VERIFICATION';

-- Both nullable: the columns are filled in by the verification flow (Step 14) and
-- by an optional password, neither of which exists at registration time.
ALTER TABLE "users" ADD COLUMN "phone_verified_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "password_hash" TEXT;

-- The model default moved from PENDING to PENDING_VERIFICATION, so the column
-- default has to move with it: a row inserted without an explicit status must
-- land in "unproven", never in the old value that no longer exists.
ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'PENDING_VERIFICATION';
