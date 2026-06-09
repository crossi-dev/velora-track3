-- CreateTable
CREATE TABLE IF NOT EXISTS "AiRateLimit" (
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AiRateLimit_pkey" PRIMARY KEY ("userId", "date")
);
