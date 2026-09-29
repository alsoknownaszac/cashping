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
-- With it, the write fails loudly at the moment the rule was skipped.
--
-- test/auth.e2e-spec.ts is what asserts that, at two altitudes. Over HTTP, where a
-- second signup for a handle another account already holds in a different case is a
-- 409 ("refuses a handle another account already holds in a different case, with a
-- 409") and a reserved word is a 400 ("refuses a reserved handle over HTTP, and claims
-- nothing for the number that tried"). And here, against the constraint itself, with
-- plain INSERTs that skip the normalizer - one value per rule, the case rule, the
-- character rule and both length bounds ("keeps a non-canonical handle out of the
-- database even when the INSERT skips normalization").
--
-- That second altitude is the one this comment used to claim falsely: it said this file
-- asserted the constraint while the e2e file sent no handle at all. Naming the tests is
-- the correction, and it is why they are named rather than summarised as "covered".
--
-- The shape rules are in here for the same reason: the database is the last place
-- that can disagree about "what is a handle", and the bounds below mirror the
-- HANDLE_MIN_LENGTH / HANDLE_MAX_LENGTH constants in handle.ts. They are literals
-- because Prisma does not model CHECK constraints, and nothing compares the two
-- automatically: moving a bound in handle.ts means writing a migration that moves the
-- regex below, and the same e2e test asserts those constants against 3 and 20, which is
-- what fails if the migration is forgotten rather than a user's signup.
--
-- Prisma does not model CHECK constraints, so this is hand-written SQL (as with
-- the enum rename in 20260926142106) and the drift check documented in that
-- migration still reports no drift afterwards - which is what keeps this honest.

ALTER TABLE "users" ADD CONSTRAINT "users_handle_canonical_form" CHECK (
  "handle" IS NULL OR ("handle" = lower("handle") AND "handle" ~ '^[a-z0-9_]{3,20}$')
);
