/*
  Warnings:

  - You are about to drop the column `hasApiAccess` on the `plan_configs` table. All the data in the column will be lost.
  - You are about to drop the column `hasLoyalty` on the `plan_configs` table. All the data in the column will be lost.
  - You are about to drop the column `hasMultiStore` on the `plan_configs` table. All the data in the column will be lost.
  - You are about to drop the column `hasReports` on the `plan_configs` table. All the data in the column will be lost.
  - You are about to drop the column `hasSunat` on the `plan_configs` table. All the data in the column will be lost.
  - You are about to drop the column `maxProducts` on the `plan_configs` table. All the data in the column will be lost.
  - You are about to drop the column `maxSalesPerDay` on the `plan_configs` table. All the data in the column will be lost.
  - You are about to drop the column `maxUsers` on the `plan_configs` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "plan_configs" DROP COLUMN "hasApiAccess",
DROP COLUMN "hasLoyalty",
DROP COLUMN "hasMultiStore",
DROP COLUMN "hasReports",
DROP COLUMN "hasSunat",
DROP COLUMN "maxProducts",
DROP COLUMN "maxSalesPerDay",
DROP COLUMN "maxUsers",
ADD COLUMN     "advancedExport" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "advancedReports" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "apiAccess" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "customers" INTEGER DEFAULT 50,
ADD COLUMN     "exportData" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "multiCash" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "multiCompany" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ordersPerMonth" INTEGER DEFAULT 100,
ADD COLUMN     "products" INTEGER DEFAULT 100,
ADD COLUMN     "storageGB" INTEGER DEFAULT 1,
ADD COLUMN     "suppliers" INTEGER DEFAULT 0,
ADD COLUMN     "supportType" TEXT NOT NULL DEFAULT 'email',
ADD COLUMN     "users" INTEGER DEFAULT 2,
ADD COLUMN     "warehouses" INTEGER DEFAULT 1;

-- AlterTable
ALTER TABLE "site_settings" ADD COLUMN     "address" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "brandName" TEXT NOT NULL DEFAULT 'MiniMarket POS',
ADD COLUMN     "description" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "email" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "facebook" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "footerText" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "heroCtaSecText" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "heroCtaSecUrl" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "heroCtaText" TEXT NOT NULL DEFAULT 'Empezar gratis',
ADD COLUMN     "heroCtaUrl" TEXT NOT NULL DEFAULT '#planes',
ADD COLUMN     "heroImage" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "instagram" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "metaDesc" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "metaTitle" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "phone" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "publicCurrency" TEXT NOT NULL DEFAULT 'PEN',
ADD COLUMN     "seoKeywords" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "showPricesPublic" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "systemVersion" TEXT NOT NULL DEFAULT 'v1.0',
ADD COLUMN     "tagline" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "tiktok" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "trialDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "whatsapp" TEXT NOT NULL DEFAULT '',
ALTER COLUMN "heroTitle" SET DEFAULT 'Gestiona tu tienda con inteligencia',
ALTER COLUMN "primaryColor" SET DEFAULT '#00c896';

-- CreateTable
CREATE TABLE "login_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT,
    "fullName" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "login_events_tenantId_idx" ON "login_events"("tenantId");

-- CreateIndex
CREATE INDEX "login_events_createdAt_idx" ON "login_events"("createdAt");

-- AddForeignKey
ALTER TABLE "login_events" ADD CONSTRAINT "login_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
