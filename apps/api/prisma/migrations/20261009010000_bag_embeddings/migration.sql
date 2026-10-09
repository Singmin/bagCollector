-- 官方袋子视觉特征向量：供小程序「拍照扫描袋子」做以图搜图匹配。
-- 纯派生数据 —— 由 worker 从官方袋子图提取，与图片版本绑定，
-- 靠 worker 的定时对账任务保证与图片始终一致；袋子删除时级联清除。
CREATE TABLE "BagEmbedding" (
    "id" TEXT NOT NULL,
    "officialBagId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "vector" DOUBLE PRECISION[] NOT NULL,
    "sourceKind" "AssetKind" NOT NULL,
    "sourceVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BagEmbedding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BagEmbedding_officialBagId_model_key" ON "BagEmbedding"("officialBagId", "model");

-- CreateIndex
-- 换特征模型时按 model 批量重算 / 清理要用到
CREATE INDEX "BagEmbedding_model_idx" ON "BagEmbedding"("model");

-- AddForeignKey
ALTER TABLE "BagEmbedding" ADD CONSTRAINT "BagEmbedding_officialBagId_fkey" FOREIGN KEY ("officialBagId") REFERENCES "OfficialBag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
