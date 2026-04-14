-- AlterTable
ALTER TABLE "channels" ADD COLUMN "dm_key" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "channels_dm_key_key" ON "channels"("dm_key");
