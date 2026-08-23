/**
 * E4 SQL 校验引擎单测
 *
 * 覆盖：
 *  - skippedSqlInvariantCheck：skip 模式显式标注
 *  - runSqlInvariantCheck 单条 source=guard：归入 failureReason，不进 SQL
 *  - runSqlInvariantCheck 单条缺 storageRef：归入 failureReason
 *  - runSqlInvariantCheck 单条 source=storage：执行 SELECT COUNT(*)
 *  - 写操作防御：SQL 模板不会产生 INSERT/UPDATE/DELETE 等
 *  - loadSqlCheckConfigFromEnv：env → SqlCheckConfig 映射
 */

import {
  runSqlInvariantCheck,
  skippedSqlInvariantCheck,
  loadSqlCheckConfigFromEnv,
  type SqlCheckConfig,
} from '../../src/sqlcheck/index.js';
import type { DeferredSqlInvariant } from '../../src/model/types.js';

describe('E4 sqlcheck', () => {
  describe('skippedSqlInvariantCheck', () => {
    it('显式标注跳过且 reason 必填', () => {
      const r = skippedSqlInvariantCheck('--skip-sql-check 显式跳过');
      expect(r.ran).toBe(false);
      expect(r.skippedReason).toBe('--skip-sql-check 显式跳过');
      expect(r.items).toEqual([]);
    });
  });

  describe('runSqlInvariantCheck — 防御性分类', () => {
    const baseConfig: SqlCheckConfig = {
      driver: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      database: 'forward',
      user: 'root',
      password: 'root',
      container: '__never_used__', // 强制 _internals 替身，不真连 storage
    };

    it('source=guard → 归入 by-design 段（不进 SQL）', async () => {
      const items: DeferredSqlInvariant[] = [
        {
          invariantId: 'INV_GUARD_1',
          expression: 'TRUE',
          source: 'guard',
        },
      ];
      const r = await runSqlInvariantCheck(items, baseConfig);
      expect(r.ran).toBe(true);
      expect(r.items).toHaveLength(1);
      expect(r.items[0].passed).toBe(false);
      expect(r.items[0].sql).toBe('');
      expect(r.items[0].failureReason).toContain('由 impl 守卫保证');
    });

    it('level=data && source=storage 但缺 storageRef → 归入 by-design', async () => {
      const items: DeferredSqlInvariant[] = [
        {
          invariantId: 'INV_NO_TABLE',
          expression: 'UNIQUE(forward_x.id)',
          source: 'storage',
          // storageRef 缺
        },
      ];
      const r = await runSqlInvariantCheck(items, baseConfig);
      expect(r.items[0].passed).toBe(false);
      expect(r.items[0].failureReason).toContain('缺 storageRef');
    });

    it('source=storage && storageRef 已声明 → 生成 SELECT COUNT(*)', async () => {
      const items: DeferredSqlInvariant[] = [
        {
          invariantId: 'INV_TBL_OK',
          expression: 'COUNT(*) > 0',
          source: 'storage',
          storageRef: 'forward_mapping_resource',
        },
      ];
      const r = await runSqlInvariantCheck(items, baseConfig);
      expect(r.items[0].sql).toBe('SELECT COUNT(*) FROM `forward_mapping_resource`;');
      // 执行会被 mock（不接 storage）；此处只断言 SQL 模板与白名单
    });
  });

  describe('SQL 白名单 — 拒绝写操作', () => {
    it('executeSelect 拒绝 INSERT/UPDATE/DELETE/DDL', async () => {
      // 验证静态扫描：含写操作的 SQL 被拒
      // 直接测试底层 executeSelect（_internals 暴露）
      const sqls = [
        'INSERT INTO t VALUES (1)',
        'UPDATE t SET x=1',
        'DELETE FROM t',
        'DROP TABLE t',
        'ALTER TABLE t ADD COLUMN x INT',
        'TRUNCATE t',
        'CREATE TABLE t (x INT)',
        'REPLACE INTO t VALUES (1)',
        'RENAME t TO t2',
        'GRANT ALL ON t TO user',
        'REVOKE ALL ON t FROM user',
      ];
      for (const sql of sqls) {
        // 通过内部 API 走防御
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const exec = (await import('../../src/sqlcheck/index.js'))._internals.executeSelect;
        await expect(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (exec as any)(
            { driver: 'mysql', host: '127.0.0.1', port: 3306, database: 'x', user: 'x', password: 'x' },
            sql
          )
        ).rejects.toThrow(/SQL 校验拒绝写操作/);
      }
    });
  });

  describe('loadSqlCheckConfigFromEnv', () => {
    const SAVED_ENV = { ...process.env };
    afterEach(() => {
      // 还原 env
      for (const k of Object.keys(process.env)) {
        if (!(k in SAVED_ENV)) delete process.env[k];
      }
      Object.assign(process.env, SAVED_ENV);
    });

    it('driver=mysql 默认配置', () => {
      delete process.env.PROTOCHAIN_SQL_DRIVER;
      const c = loadSqlCheckConfigFromEnv();
      expect(c).toBeDefined();
      expect(c!.driver).toBe('mysql');
      expect(c!.host).toBe('127.0.0.1');
      expect(c!.port).toBe(3306);
      expect(c!.database).toBe('forward');
      expect(c!.user).toBe('root');
      expect(c!.password).toBe('root');
    });

    it('driver=postgres 缺 PGPASSWORD → undefined', () => {
      process.env.PROTOCHAIN_SQL_DRIVER = 'postgres';
      delete process.env.PROTOCHAIN_SQL_PASSWORD;
      const c = loadSqlCheckConfigFromEnv();
      expect(c).toBeUndefined();
    });

    it('driver=postgres 配齐 PGPASSWORD → 解析成功', () => {
      process.env.PROTOCHAIN_SQL_DRIVER = 'postgres';
      process.env.PROTOCHAIN_SQL_PASSWORD = 'secret';
      const c = loadSqlCheckConfigFromEnv();
      expect(c).toBeDefined();
      expect(c!.driver).toBe('postgres');
      expect(c!.port).toBe(5432);
      expect(c!.password).toBe('secret');
    });
  });
});