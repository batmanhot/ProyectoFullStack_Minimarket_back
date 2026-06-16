-- AlterTable
ALTER TABLE "product_batches" ADD COLUMN     "notes" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "priceBuy" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "product_variants" ADD COLUMN     "attributes" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "barcode" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "stockMin" DOUBLE PRECISION NOT NULL DEFAULT 2;
