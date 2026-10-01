// 集成测试的环境自足默认值。
// 必须作为测试脚本的第一个 import：@prisma/client 在模块加载阶段会自动向上
// 查找并加载仓库根目录的 .env（指向开发库），若不先占位，测试会静默连到开发库。
// 显式导出的环境变量仍然优先生效（例如本机 Redis 端口被 Windows 保留时
// 用 REDIS_URL=redis://127.0.0.1:16380 覆盖）。
process.env.DATABASE_URL ??= 'postgresql://bagcollect:bagcollect_test@127.0.0.1:5433/bagcollect_test';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6380';
process.env.JWT_SECRET ??= 'local-test-secret-with-at-least-thirty-two-characters';
