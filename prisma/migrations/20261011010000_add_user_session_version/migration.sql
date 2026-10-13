-- Increments invalidate previously issued tenant JWTs after security changes.
ALTER TABLE "users" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
