-- Add MessageFeedback table for explicit user feedback on agent responses.
CREATE TABLE "MessageFeedback" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "clientMessageId" TEXT NOT NULL,
    "feedback" TEXT NOT NULL,
    "userInput" TEXT,
    "assistantAnswer" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageFeedback_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MessageFeedback_businessId_clientMessageId_key"
    ON "MessageFeedback"("businessId", "clientMessageId");

CREATE INDEX "MessageFeedback_businessId_feedback_createdAt_idx"
    ON "MessageFeedback"("businessId", "feedback", "createdAt");
