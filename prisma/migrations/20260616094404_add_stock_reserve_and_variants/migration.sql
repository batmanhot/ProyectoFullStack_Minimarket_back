-- CreateTable
CREATE TABLE "stock_reserves" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_reserves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_reserve_items" (
    "id" TEXT NOT NULL,
    "reserveId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "stock_reserve_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_reserve_items_reserveId_productId_key" ON "stock_reserve_items"("reserveId", "productId");

-- AddForeignKey
ALTER TABLE "stock_reserves" ADD CONSTRAINT "stock_reserves_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reserves" ADD CONSTRAINT "stock_reserves_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reserve_items" ADD CONSTRAINT "stock_reserve_items_reserveId_fkey" FOREIGN KEY ("reserveId") REFERENCES "stock_reserves"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_reserve_items" ADD CONSTRAINT "stock_reserve_items_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
