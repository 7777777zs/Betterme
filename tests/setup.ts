import "dotenv/config";

/**
 * 所有测试共用的初始化。
 *
 * 只做一件事：加载 .env。集成测试需要 TEST_DATABASE_URL，
 * 单元测试不需要数据库但也无害。
 *
 * 刻意不在这里做数据库连接或清库：那属于集成测试自己的 setup，
 * 让单元测试为数据库付出启动代价是没必要的。
 */
process.env.NODE_ENV ??= "test";
