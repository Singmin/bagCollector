-- 运行时可变的应用设置（键值对）。
-- 与 env 的分工：env 是「部署时确定、改动要重启容器」的基础设施配置；
-- 这里放「运营期间要调的业务参数」（目前是拍照扫描匹配的判定阈值），改了立刻生效。
-- 表初始为空即可：缺失的键由 env 默认值兜底。
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);
