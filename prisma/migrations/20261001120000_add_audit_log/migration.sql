-- Step 32: the append-only audit log.
--
-- Written by hand rather than generated, because the trigger at the bottom *is* the migration:
-- `prisma migrate` describes columns and indexes, and "this table may not be revised" is neither.
-- The table itself is exactly what `schema.prisma` declares, so `prisma migrate dev` sees no
-- drift after this runs.

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "user_id" UUID,
    "subject_id" TEXT,
    "outcome" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_user_id_created_at_idx" ON "audit_log"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_log_action_created_at_idx" ON "audit_log"("action", "created_at");

-- Append-only, enforced here because it is a property of the data rather than of the code that
-- happens to write it today.
--
-- A `RAISE EXCEPTION` in a trigger rather than `REVOKE UPDATE, DELETE ON audit_log`: this app
-- connects as the database's owner (`DATABASE_URL` is the migration role), and an owner is
-- precisely who a `REVOKE` does not stop. The trigger stops everyone, including this app.
--
-- `ERRCODE = 'restrict_violation'` so a caller sees a code that says "a constraint refused this"
-- rather than an unclassified `plpgsql` exception, which a driver reports as a 500.
--
-- What this does not cover, stated so nobody mistakes it for more: `TRUNCATE` (a row-level trigger
-- does not fire for it - which is also what lets a test reset the table between runs) and anyone
-- able to disable the trigger. And it makes the log *append-only*, not tamper-*evident*: a row
-- removed by such a route leaves no mark behind. `AuditService`'s docstring prices closing that.
CREATE FUNCTION "audit_log_is_append_only"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only: % is refused (Step 32)', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_log_no_revision"
    BEFORE UPDATE OR DELETE ON "audit_log"
    FOR EACH ROW
    EXECUTE FUNCTION "audit_log_is_append_only"();
