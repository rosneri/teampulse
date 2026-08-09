-- AlterTable
ALTER TABLE "open_issue" ADD COLUMN     "initiative_name" TEXT,
ADD COLUMN     "project_name" TEXT;

-- CreateTable
CREATE TABLE "person_focus" (
    "person_id" TEXT NOT NULL,
    "focus" TEXT NOT NULL,
    "set_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "person_focus_pkey" PRIMARY KEY ("person_id")
);
