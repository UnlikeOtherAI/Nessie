-- CreateEnum
CREATE TYPE "ChannelType" AS ENUM ('standard', 'dm');

-- AlterTable
ALTER TABLE "channels" ADD COLUMN "type" "ChannelType" NOT NULL DEFAULT 'standard';
