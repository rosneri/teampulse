-- CreateTable
CREATE TABLE "activity" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "work_type" TEXT,
    "ts" TIMESTAMPTZ(3) NOT NULL,
    "url" TEXT,
    "title" TEXT,
    "body" TEXT,
    "meta" JSONB,

    CONSTRAINT "activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "open_issue" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "work_type" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "synced_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "open_issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_output" (
    "id" BIGSERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "window_end" TIMESTAMPTZ(3) NOT NULL,
    "input_digest" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_output_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_run" (
    "source" TEXT NOT NULL,
    "last_run" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sync_run_pkey" PRIMARY KEY ("source")
);

-- CreateIndex
CREATE INDEX "activity_person_id_ts_idx" ON "activity"("person_id", "ts" DESC);

-- CreateIndex
CREATE INDEX "activity_type_ts_idx" ON "activity"("type", "ts" DESC);

-- CreateIndex
CREATE INDEX "activity_work_type_ts_idx" ON "activity"("work_type", "ts" DESC);

-- CreateIndex
CREATE INDEX "activity_ts_idx" ON "activity"("ts" DESC);

-- CreateIndex
CREATE INDEX "open_issue_person_id_idx" ON "open_issue"("person_id");

-- CreateIndex
CREATE INDEX "ai_output_person_id_kind_created_at_idx" ON "ai_output"("person_id", "kind", "created_at" DESC);
