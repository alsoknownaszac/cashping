-- Step 15: handles are stored in canonical form.
--
-- Case-insensitive uniqueness is enforced by *storage*, not by a functional index:
-- every handle is lower-cased by src/identity/handle/handle.ts before it is
-- written, so the existing unique index on "handle" already behaves
-- case-insensitively (@Miriam and @miriam both arrive as "miriam").
--
-- This CHECK is the backstop for that invariant. Without it, a future code path
-- that wrote a handle without normalizing would silently double the namespace -
-- "Miriam" and "miriam" would be two different users - and nothing would error.
-- With it, the write fails loudly at the moment the rule was skipped, and
-- test/auth.e2e-spec.ts asserts that it does.
--
-- The shape rules are in here for the same reason: the database is the last place
-- that can disagree about "what is a handle", and the bounds below mirror the
-- HANDLE_MIN_LENGTH / HANDLE_MAX_LENGTH constants in handle.ts.
--
-- Prisma does not model CHECK constraints, so this is hand-written SQL (as with
-- the enum rename in 20260926142106) and the drift check documented in that
-- migration still reports no drift afterwards - which is what keeps this honest.

ALTER TABLE "users" ADD CONSTRAINT "users_handle_canonical_form" CHECK (
  "handle" IS NULL OR ("handle" = lower("handle") AND "handle" ~ '^[a-z0-9_]{3,20}$')
);
