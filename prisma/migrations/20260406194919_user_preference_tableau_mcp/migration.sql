-- CreateTable
CREATE TABLE "UserPreference" (
    "id" TEXT NOT NULL,
    "enterpriseId" TEXT,
    "teamId" TEXT,
    "userId" TEXT NOT NULL,
    "tableauMcpUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserPreference_teamId_userId_idx" ON "UserPreference"("teamId", "userId");

-- CreateIndex
CREATE INDEX "UserPreference_enterpriseId_userId_idx" ON "UserPreference"("enterpriseId", "userId");
