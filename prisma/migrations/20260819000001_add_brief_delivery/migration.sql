-- CreateTable
CREATE TABLE "BriefDelivery" (
    "id" TEXT NOT NULL,
    "teamId" TEXT,
    "userId" TEXT NOT NULL,
    "facilityName" TEXT,
    "metricKey" TEXT NOT NULL,
    "periodMonth" TEXT NOT NULL,
    "contentSig" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BriefDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BriefDelivery_teamId_userId_idx" ON "BriefDelivery"("teamId", "userId");

-- CreateIndex
CREATE INDEX "BriefDelivery_periodMonth_idx" ON "BriefDelivery"("periodMonth");
