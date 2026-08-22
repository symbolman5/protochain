/**
 * m-check（M 单元语义闸门）规则类型与报告结构
 *
 * 设计依据：IMPLEMENTATION-PLAN.md §E1、IMPLEMENTATION-ACCEPTANCE.md §E1
 *
 * 与现有 checker 的职责边界：
 * - checker 已做 from/to 存在性校验（src/checker/index.ts:495-512），
 *   m-check 不重复（REVIEW §5.2）
 * - m-check 聚焦"模型作者写代码时常犯的语义错误"：
 *   命名规范 / 跨协议 ID 唯一性 / 附属实体归属 / 旧字符禁用 / ID 转义前置
 */

import type { SourceProtocolModel } from '../model/types.js';

/** 规则严重级别（沿用 CheckIssue） */
export type MCheckSeverity = 'error' | 'warning' | 'info';

/** 规则 ID（供 ruleId→msg/suggestion 索引与跨 MR 引用） */
export type MCheckRuleId =
  | 'M001' // 命名规范
  | 'M002' // 跨协议 ID 唯一性
  | 'M003' // 附属实体归属
  | 'M004' // 旧字符 / 中文标点禁用
  | 'M005'; // ID 转义前置（SANY 解析异常前置到 M 阶段）

/** 一条 m-check 发现 */
export interface MCheckIssue {
  ruleId: MCheckRuleId;
  severity: MCheckSeverity;
  /** 触犯规则的元素 ID（如 INV-PS1 / T1 / SE1） */
  elementId: string;
  /** 元素类型（state / transition / invariant / ...） */
  elementType: string;
  /** 元素路径（如 derivable.invariants[3].id） */
  elementPath?: string;
  /** 人类可读消息 */
  message: string;
  /** 建议修复方式 */
  suggestion?: string;
}

/** 一条规则的执行结果 */
export interface MCheckRuleResult {
  ruleId: MCheckRuleId;
  passed: boolean;
  issues: MCheckIssue[];
}

/** m-check 整体报告 */
export interface MCheckReport {
  passed: boolean;
  /** 模型版本（用于追溯） */
  modelVersion?: string;
  /** 模型名称 */
  modelName?: string;
  /** 每条规则的结果 */
  rules: MCheckRuleResult[];
  /** 汇总 issue 数 */
  summary: {
    errors: number;
    warnings: number;
    infos: number;
  };
  /** 检查时间戳 */
  checkedAt: string;
}

/** 规则上下文（多协议项目下需要跨模型对比） */
export interface MCheckContext {
  /** 当前模型 */
  model: SourceProtocolModel;
  /** 多协议项目下的所有子协议模型（key 为 protocolId，如 'P1'/'P2'） */
  peerModels?: Record<string, SourceProtocolModel>;
}

/** 单条规则的定义接口 */
export interface MCheckRule {
  ruleId: MCheckRuleId;
  description: string;
  /** 校验函数：返回发现的 issue 列表 */
  check(ctx: MCheckContext): MCheckIssue[];
}