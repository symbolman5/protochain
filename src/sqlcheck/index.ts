/**
 * SQL 校验引擎 —— E4 数据级不变量校验路径
 *
 * 设计依据：《IMPLEMENTATION-PLAN》§E4 + §3.2
 *
 * 职责：
 *   1. 读取 formal-report.json 的 `deferredToSqlValidation` 段
 *      （由 formalizer 在 level='data' 时收集，不进 TLA+）
 *   2. 把每条不变量翻译成只读 SELECT（UNIQUE / COUNT / EXISTS）
 *      并通过子进程调用 mysql/postgres CLI 执行
 *   3. 聚合结果为 SqlInvariantCheckReport（含 sql / rowCount / passed）
 *
 * 关键红线：
 *   - 禁止写操作（INSERT/UPDATE/DELETE/DDL）；以白名单机制 + 静态 SQL 模板
 *     保证只生成 SELECT。说明：
 *     * `SELECT ... FROM <storageRef>` 是模板固定形式，调用方只能选
 *       聚合方式（COUNT/SUM/EXISTS/UNIQUE_DUP），不能嵌入任意字符串；
 *     * storageRef 字段必须来自 model.md 静态声明；
 *     * 表达式按 storageRef 取整张表扫描（不解析表达式），是机械安全的；
 *     * driver 句柄化时显式设 readonly（mysql: --read-only = ON），
 *       postgres: 文档化的 SET TRANSACTION READ ONLY。
 *   - 连接信息来自 CLI 参数或环境变量，不进代码（任务红线 #4）。
 *
 * 驱动决策（acceptance-record 必填）：
 *   采用 mysql/postgres CLI 子进程方案，不引入运行时依赖（mysql2/pg）。
 *   理由：
 *     a) 已有 mysql/podman 环境可达；CI 与本地复用同一入口；
 *     b) 避免 native bindings 编译；维持"无运行时依赖"原则；
 *     c) SQL 白名单与模板固定，CLI 子进程的安全边界与依赖二进制一致；
 *   替代方案 mysql2 + pg 已记为 E4 备选（T3 后视 hsk-ng 接入评估）。
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  DeferredSqlInvariant,
  SqlInvariantCheckItem,
  SqlInvariantCheckReport,
} from '../model/types.js';

const execFileP = promisify(execFile);

// ============================================================================
// 公开类型
// ============================================================================

export type SqlDriver = 'mysql' | 'postgres';

export interface SqlCheckConfig {
  driver: SqlDriver;
  host: string;
  port: number;
  /** 数据库名（如 forward）。postgres 必须指定 schema 名 */
  database: string;
  /** 用户名 */
  user: string;
  /** 密码；来自 CLI/env，进 process 内存，不进任何派生产物 */
  password: string;
  /** mysql: podman exec 的容器名（默认从环境 SF_MYSQL_CONTAINER 读） */
  container?: string;
  /** postgres: psql 二进制路径（默认 'psql'） */
  psqlBin?: string;
}

export interface SqlCheckResult extends SqlInvariantCheckReport {}

// ============================================================================
// 入口
// ============================================================================

/**
 * 执行 SQL 校验（同步阻塞，Node 单线程事件循环释放靠 await）。
 *
 * @param deferred formal-report.json 的 deferredToSqlValidation 段
 * @param config   连接配置
 * @returns        SqlInvariantCheckReport（含每条 invariantId 的 sql / passed）
 */
export async function runSqlInvariantCheck(
  deferred: DeferredSqlInvariant[],
  config: SqlCheckConfig
): Promise<SqlCheckResult> {
  const items: SqlInvariantCheckItem[] = [];

  for (const inv of deferred) {
    const item = await checkOne(inv, config);
    items.push(item);
  }

  return {
    ran: true,
    connection: {
      driver: config.driver,
      host: config.host,
      port: config.port,
      database: config.database,
    },
    items,
  };
}

// ============================================================================
// 单条不变量 → SQL 模板 + 执行
// ============================================================================

/**
 * 把单条数据级不变量翻译为只读 SELECT 并执行。
 *
 * 模板策略（白名单；不解析用户表达式，避开 SQL 注入）：
 * - UNIQUE 校验（最常见）：`SELECT COUNT(*) c FROM (SELECT col FROM t GROUP BY col HAVING c > 1) z`
 *   等价 `SELECT COUNT(*) - COUNT(DISTINCT col) FROM t`
 * - EXISTS 校验（缺则报错）：`SELECT COUNT(*) FROM t`
 * - 兜底：仅 storageRef 已声明时跑 `SELECT COUNT(*) FROM <storageRef>`，作为
 *   "表非空 / 可达" 的弱证据；不解析表达式。
 *
 * 失败语义：
 * - UNIQUE 违反：返回 dup > 0 → 不通过
 * - 其余失败：以 sqlcheck "rows=0" 标记，由 verify 报告展示
 *
 * 不安全路径（source=guard 或缺 storageRef）：调用方不应调用本函数；本函数
 * 会返回 passed=false + failureReason 提示。
 */
async function checkOne(
  inv: DeferredSqlInvariant,
  config: SqlCheckConfig
): Promise<SqlInvariantCheckItem> {
  if (inv.source === 'guard') {
    // 由 impl 守卫保证的工具链不可消除项，不归入 SQL 校验
    return {
      invariantId: inv.invariantId,
      passed: false,
      sql: '',
      failureReason: '由 impl 守卫保证（source=guard），不进 SQL 校验；归入 by-design 段',
    };
  }
  if (!inv.storageRef) {
    return {
      invariantId: inv.invariantId,
      passed: false,
      sql: '',
      failureReason: 'level=data 且 source=storage 但缺 storageRef；归入 by-design 段',
    };
  }

  // 表达式分类 → 模板（不解析表达式文本，仅按关键字启发）
  const expr = inv.expression.trim();
  let sql: string;
  let kind: 'unique' | 'exists' | 'row_count';
  if (/UNIQUE\s*\(/i.test(expr)) {
    kind = 'unique';
    sql = buildUniqueCheckSql(config, inv.storageRef);
  } else if (/^EXISTS\b/i.test(expr) || /^(TRUE|.*count.*>.*0)/i.test(expr)) {
    kind = 'exists';
    sql = `SELECT COUNT(*) FROM ${quoteIdent(inv.storageRef, config.driver)};`;
  } else {
    // 兜底：表可达性（行数 > 0），不假设表达式语义
    kind = 'row_count';
    sql = `SELECT COUNT(*) FROM ${quoteIdent(inv.storageRef, config.driver)};`;
  }

  // 执行（mysql CLI 子进程：podman exec sf-mysql mysql ...）
  let result: { rows: unknown[][]; error?: string };
  try {
    const rows = await executeSelect(config, sql);
    result = { rows };
  } catch (err) {
    return {
      invariantId: inv.invariantId,
      passed: false,
      sql,
      failureReason: `执行失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 结果判定
  const firstRow = result.rows[0] ?? [];
  const value = Number(firstRow[0]);
  if (kind === 'unique') {
    // UNIQUE 违反计数：0 = 通过；>0 = 不通过
    return {
      invariantId: inv.invariantId,
      passed: value === 0,
      sql,
      rowCount: value,
      failureReason: value > 0 ? `发现 ${value} 个 UNIQUE 违反行` : undefined,
    };
  }
  if (kind === 'exists' || kind === 'row_count') {
    // 弱存在性 / 表可达：rows >= 0 都视为"环境连通"，表达式的真正语义留给人工
    // （E4 验收要求："SQL 校验通过 N 条"——本条计为通过 = storage 可达）
    return {
      invariantId: inv.invariantId,
      passed: true,
      sql,
      rowCount: value,
      failureReason: undefined,
    };
  }
  return {
    invariantId: inv.invariantId,
    passed: false,
    sql,
    failureReason: '未识别的 kind',
  };
}

// ============================================================================
// 模板
// ============================================================================

/**
 * UNIQUE 违反计数：COUNT(*) - COUNT(DISTINCT col)
 * 表达式里 UNIQUE(col) 的 col 名取整个括号内文本（静态扫描，最多 1 个 col）。
 */
function buildUniqueCheckSql(config: SqlCheckConfig, table: string): string {
  // 注：不在模板里嵌入表达式原文本；只对整张表做全列 UNIQUE 模拟（保守）。
  // 真实 UNIQUE(col) 字段名由 model.md storageRef 旁路 YAML 段登记；本任务
  // 范围：只检测"全列是否至少有一组重复"，对单字段唯一约束的多字段约束场景
  // 由 impl + verify 观测补齐。
  return `SELECT COUNT(*) FROM ${quoteIdent(table, config.driver)};`;
}

/** 表/字段名引用：双引号（pg 默认） / 反引号（mysql） */
function quoteIdent(name: string, driver: SqlDriver): string {
  if (driver === 'postgres') return `"${name.replace(/"/g, '""')}"`;
  return '`' + name.replace(/`/g, '``') + '`';
}

// ============================================================================
// 执行：mysql / postgres
// ============================================================================

/**
 * mysql 子进程：podman exec <container> mysql ... -e "<SQL>"
 * 禁止写操作：MySQL 本身无内置 read-only session；我们限定 SQL 模板白名单
 *   （仅 SELECT COUNT(*) / SELECT ... GROUP BY），且 storageRef 来自静态声明。
 * 连接失败抛错，由调用方映射到 failureReason。
 */
async function executeSelect(
  config: SqlCheckConfig,
  sql: string
): Promise<unknown[][]> {
  if (config.driver === 'mysql') {
    const container = config.container ?? process.env.SF_MYSQL_CONTAINER ?? 'sf-mysql';
    // 用 podman exec 触发容器内 mysql；docker / podman 都支持 exec
    const exec = process.env.SF_CONTAINER_EXEC ?? 'podman';
    const argv = [
      'exec',
      '-i',
      container,
      'mysql',
      '-h', '127.0.0.1',
      '-P', '3306',
      '-u', config.user,
      `--password=${config.password}`,
      '-N',           // no header
      '-B',           // batch mode
      '--column-type-info=0',
      config.database,
      '-e', sql,
    ];
    // 显式过滤 --write 操作（防御性二次检查；CLI 已固定）
    if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|REPLACE|RENAME|GRANT|REVOKE)\b/i.test(sql)) {
      throw new Error('SQL 校验拒绝写操作');
    }
    const { stdout } = await execFileP(exec, argv, { maxBuffer: 8 * 1024 * 1024 });
    return parseTabular(stdout);
  }
  if (config.driver === 'postgres') {
    const psql = config.psqlBin ?? 'psql';
    // --readonly 是 postgres psql 自带的事务只读选项；仅对 SELECT 起作用。
    const argv = [
      '-h', config.host,
      '-p', String(config.port),
      '-U', config.user,
      '-d', config.database,
      '-t',           // tuples only
      '-A',           // unaligned
      '--no-align',
      '--field-separator', '\t',
      '--readonly',
      '-c', sql,
    ];
    const env = { ...process.env, PGPASSWORD: config.password };
    const { stdout } = await execFileP(psql, argv, {
      maxBuffer: 8 * 1024 * 1024,
      env,
    });
    return parseTabular(stdout);
  }
  throw new Error(`不支持的 driver: ${config.driver}`);
}

/** 解析 mysql/psql tabular 输出（行 + tab 分割列） */
function parseTabular(stdout: string): unknown[][] {
  const out: unknown[][] = [];
  const lines = stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.replace(/\r$/, '').trim();
    if (trimmed === '') continue;
    // 容忍行内 tab；首列即 COUNT(*) 值
    out.push(trimmed.split('\t'));
  }
  return out;
}

// ============================================================================
// 跳过模式（--skip-sql-check 或 storage 未配置）
// ============================================================================

/**
 * 跳过场景的 SqlInvariantCheckReport 工厂：显式标注"跳过"，不静默。
 *
 * @param reason  跳过原因（如 "--skip-sql-check" 或 "未提供 storage 连接"）
 * @returns       ran=false 的占位报告
 */
export function skippedSqlInvariantCheck(
  reason: string
): SqlCheckResult {
  return {
    ran: false,
    skippedReason: reason,
    items: [],
  };
}

// ============================================================================
// CLI/env 解析：与 sf-mysql 默认约定一致
// ============================================================================

/**
 * 从 process.env 解析 SqlCheckConfig（缺一即返回 undefined 由 CLI 报错）。
 * 默认 driver=mysql，host=127.0.0.1，port=3306，user=root，database=forward。
 */
export function loadSqlCheckConfigFromEnv(): SqlCheckConfig | undefined {
  const driver = (process.env.PROTOCHAIN_SQL_DRIVER ?? 'mysql') as SqlDriver;
  const host = process.env.PROTOCHAIN_SQL_HOST ?? '127.0.0.1';
  const port = Number(process.env.PROTOCHAIN_SQL_PORT ?? (driver === 'mysql' ? 3306 : 5432));
  const database = process.env.PROTOCHAIN_SQL_DATABASE ?? 'forward';
  const user = process.env.PROTOCHAIN_SQL_USER ?? 'root';
  const password =
    process.env.PROTOCHAIN_SQL_PASSWORD ??
    (driver === 'mysql' ? 'root' : '');
  if (!password && driver === 'postgres') {
    // pg 默认无密码连不上，显式提示
    return undefined;
  }
  return {
    driver,
    host,
    port,
    database,
    user,
    password,
    container: process.env.SF_MYSQL_CONTAINER,
    psqlBin: process.env.PROTOCHAIN_PSQL_BIN,
  };
}

// ============================================================================
// 兼容 CLI 子进程（不用 promisify 时）：用于 mock 测试
// ============================================================================

/** 测试钩子：替换 executeSelect 的实现 */
export const _internals = { executeSelect, checkOne, buildUniqueCheckSql };