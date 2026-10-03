-- Step 34c: the account's email address and the moment it was proved.
--
-- Two columns rather than one, and the split is the whole design: `email` is the address the
-- account *claims* (written when POST /v1/auth/email attaches it) and `email_verified_at` is
-- the moment a code proved the account controls it. "Attached but not confirmed" is therefore
-- `email IS NOT NULL AND email_verified_at IS NULL`, which is a state a receipt must never be
-- sent in - an address is only good for delivery once the person who receives it has proved
-- they can read it. A boolean would collapse those two facts and lose the *when*.
--
-- Both columns are nullable. An account is useful without an address (every account on Day 1
-- is), and Step 34d's Google-SSO account may arrive with one that is already verified.
--
-- Uniqueness is on the stored, lower-cased address, following the one-spelling-per-identity
-- rule `phone_number` already follows: `normalizeEmailAddress` lower-cases and trims before
-- the write, so `Miriam@Example.com` and `miriam@example.com` are one value and the unique
-- index below is what makes them one account. Postgres treats NULLs as distinct, so the many
-- accounts without an address do not collide.
--
-- Written by hand rather than by `prisma migrate dev`; the schema declares exactly this, so
-- `prisma migrate dev` sees no drift after it runs.

ALTER TABLE "users" ADD COLUMN "email" TEXT;
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
