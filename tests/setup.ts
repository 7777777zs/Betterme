import "dotenv/config";

/**
 * 所有测试共用的初始化。
 *
 * 只做一件事：加载 .env，让集成测试能读到 TEST_DATABASE_URL。
 *
 * 刻意不在这里连数据库或清库：那属于集成测试自己的 setup，
 * 没必要让纯单元测试为数据库付出启动代价。
 */
