-- AlterTable
ALTER TABLE "Installation" ADD COLUMN     "userId" TEXT;

-- CreateIndex
CREATE INDEX "Installation_userId_idx" ON "Installation"("userId");
