-- Step 34a: the transaction PIN.
--
-- Four nullable columns on `users`, added by hand rather than by `prisma migrate dev`, and
-- the interesting half of this migration is what is *absent* from the table rather than what
-- is in it.
--
-- There is no column holding the PIN, none holding its length, and no `char(4)` type on the
-- hash: the column holds a scrypt hash (`scrypt$N$r$p$salt$hash`) whose length is a property
-- of the *hash*, and "exactly four digits" is a validation rule enforced before hashing
-- (`PIN_LENGTH` in `configuration.ts`, `PIN_PATTERN` in `pin-pattern.ts`). A length column,
-- or a narrower type here, would be a second and drifting statement of the same rule.
--
-- The columns are nullable because a Google-SSO account (Step 34d) is created without a PIN
-- and is asked for one as its next step, so "has a PIN" has to be expressible as
-- `transaction_pin_hash IS NULL` rather than as a status.
--
-- `transaction_pin_attempts` is the one NOT NULL column, and the application never writes it
-- the value it just read: it increments it in the database (`{ increment: 1 }`). A
-- read-then-write would let concurrent guesses share one attempt, and for a four-digit PIN
-- that is the difference between a lockout and a sweep of ten thousand values.

ALTER TABLE "users" ADD COLUMN "transaction_pin_hash" TEXT;
ALTER TABLE "users" ADD COLUMN "transaction_pin_set_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "transaction_pin_attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "transaction_pin_locked_until" TIMESTAMP(3);
