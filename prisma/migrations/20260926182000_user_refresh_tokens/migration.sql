-- Step 16: the refresh-token store that makes `POST /v1/auth/refresh` revocable.
--
-- Written in the shape Prisma would generate for the `RefreshToken` model so the
-- drift check stays clean (Prisma's own naming for the index and the constraint is
-- kept deliberately: `refresh_tokens_token_hash_key`,
-- `refresh_tokens_user_id_created_at_idx`, `refresh_tokens_user_id_fkey`).
--
-- No data migration is needed - the table starts empty, and the only existing
-- consequence is that every session issued before this migration has no refresh
-- token and therefore ends when its access token expires. That is the correct
-- behaviour for a feature that did not exist yet, and it is why this constraint can
-- be added in one step rather than behind a backfill.

CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- One row per live token: the digest is how a presented token is looked up, and a
-- duplicate would mean two sessions sharing a credential.
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- Reuse detection and "sign out everywhere" both read every token for a user;
-- `created_at` is in the index so the newest-first scan is an index scan.
CREATE INDEX "refresh_tokens_user_id_created_at_idx" ON "refresh_tokens"("user_id", "created_at");

-- Deleting a user takes their sessions with them (the same cascade the OTP rows
-- have), so an account deletion cannot leave a working refresh token behind.
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
