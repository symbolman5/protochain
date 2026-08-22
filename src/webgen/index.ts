/**
 * Web 检阅界面生成器 —— E7 P0（只读静态检阅，纯机械）
 *
 * 设计依据：
 * - IMPLEMENTATION-PLAN.md §E7、IMPLEMENTATION-ACCEPTANCE.md §E7 P0
 * - verification/acceptance/E7-P0/design-notes.md（设计笔记）
 * - E7-P0-START.txt §2 / §5（启动提示词）
 *
 * 职责（100% 机械、无 AI、不读 process.env、不读 bindings.yaml）：
 * 1. 读 derived/specs.json（Envelope 形态，E2 产物）
 * 2. 读 derived/test-cases.json（E2 产物）
 * 3. 读 derived/verification/verification-report.json（implcheck/verifier 产物）
 * 4. 读 derived/impl-check/impl-check-report.json（implcheck 产物）
 * 5. 读 derived/diff/model-diff.json（versioner/differ 产物，可选）
 * 6. 读 derived/impact-analysis.json（differ 产物，可选）
 * 7. 读 protocol/model.md（仅取元数据 + 状态机图）
 * 8. 构造 WebDataJson（结构化中间表示）
 * 9. 写出 web/data.json + web/docs/public/data.json
 * 10. 写出 web/docs/*.md（VitePress 输入）
 * 11. 调 `npx vitepress build` → web/.vitepress/dist/
 *
 * 与现有命名：
 * - `webgen` = Web 检阅界面生成器（机械）
 * - `bindgen` = binding 骨架生成器（机械）
 * - `binder`  = binding 完整性校验器
 *
 * 安全边界（设计笔记 §5）：
 * - 不读 process.env（即使子进程环境含 SECRET_TOKEN_XYZ，web 产物也不出现）
 * - 不读 bindings.yaml（authConfig.tokenEnv/secretEnv/passwordEnv 完全不入站）
 * - 不调 AI 模块（拒绝工具链 random 性侵入展示层）
 *
 * 不在 P0 范围（明确防范围蔓延，附录 B.4）：
 * - mock 服务 / 团队协作 / 环境管理 / Apifox 克隆
 * - 模型侧输入管理（在线编辑 scenarios / bindings）
 * - Web 服务接触令牌环境变量
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type {
  SourceProtocolModel,
  InterfaceSpec,
  TestCaseSet,
  VerificationReport,
  ImplCheckReport,
  ModelDiff,
  ImpactAnalysis,
  FieldSpec,
  SchemaExpression,
  JSONSchema,
} from '../model/types.js';
import {
  envelopeMigrate,
  isSpecsEnvelope,
  type SpecsEnvelope,
} from '../specifier/envelope.js';

// ============================================================================
// 类型定义
// ============================================================================

/** web/data.json schema 版本 */
export const WEB_DATA_SCHEMA_VERSION = '1.0' as const;

/** web/data.json 顶层 */
export interface WebDataJson {
  schemaVersion: typeof WEB_DATA_SCHEMA_VERSION;
  generatedAt: string;
  sourceModelVersion: string;
  /** 协议元数据（人读） */
  protocol: {
    name: string;
    version: string;
    purpose: string;
    roles: Array<{ id: string; name: string; roleType?: string }>;
  };
  interfaces: WebInterfaceView[];
  testCases: WebTestCaseView[];
  verification: WebVerificationView;
  diff: WebDiffView | null;
  impact: WebImpactView | null;
  implCheck: WebImplCheckView | null;
  stateMachine: { mermaid: string };
  redactionNotice: string[];
}

/** 接口详情视图（人读） */
export interface WebInterfaceView {
  id: string;
  name: string;
  kind: 'system' | 'observation';
  actionType?: 'state_transition' | 'attribute_update';
  description: string;
  requestSchema?: JSONSchema;
  responseSchema?: JSONSchema;
  inputs: FieldSpec[];
  outputs: FieldSpec[];
  precondition?: string;
  postconditions: string[];
  preconditions?: SchemaExpression[];
  postconditionExpressions?: SchemaExpression[];
  sideEffects?: SchemaExpression[];
  schemaKind?: 'structured' | 'legacy-stub' | 'description-only';
  schemaDegradedReasons?: string[];
  invariantIds?: string[];
  observesResourcePoolId?: string;
  /** 触发角色 ID（来自 metadata.roles + transitions.trigger） */
  triggerRoleId?: string;
}

/** 测试用例浏览器视图 */
export interface WebTestCaseView {
  id: string;
  length: number;
  stateIds: string[];
  transitionIds: string[];
  description?: string;
  hasException?: boolean;
  verificationPassed?: boolean;
  verificationSkipped?: boolean;
  deviations: Array<{
    action: string;
    state: string;
    kind: string;
    expected: string;
    actual: string;
    field?: string;
    legacy?: string;
    impl?: string;
  }>;
}

/** 验证报告对比视图 */
export interface WebVerificationView {
  hasReport: boolean;
  passed: boolean;
  counts: { passed: number; failed: number; skipped: number };
  verifiedAt?: string;
  deviationSummary: {
    stateMismatch: number;
    fieldMismatch: number;
    missingAction: number;
    invariantViolation: number;
    timingViolation: number;
    other: number;
  };
  /** 双跑对账（legacy vs impl 并排） */
  sideBySide: Array<{
    action: string;
    state: string;
    field: string;
    legacy: string;
    impl: string;
    matched: boolean;
  }>;
}

/** 模型 diff 视图 */
export interface WebDiffView {
  metadataChanges: Array<{ path: string; kind: string; oldValue?: string; newValue?: string }>;
  readableChanges: Array<{ path: string; kind: string; oldValue?: string; newValue?: string }>;
  derivableChanges: Array<{
    elementType: string;
    elementId: string;
    kind: string;
    fieldChanges?: Array<{ path: string; kind: string; oldValue?: string; newValue?: string }>;
  }>;
  diffedAt: string;
  summary: string;
}

/** 影响分析视图 */
export interface WebImpactView {
  affectedSteps: string[];
  affectedArtifacts: string[];
  incrementalPlan: string[];
  analyzedAt: string;
  humanReadable: Array<{ trigger: string; affected: string[] }>;
}

/** 实现完整性视图 */
export interface WebImplCheckView {
  hasReport: boolean;
  passed: boolean;
  total: number;
  found: number;
  missing: number;
  missingActions: Array<{ interfaceId: string; interfaceName: string; location?: string }>;
}

// ============================================================================
// derive-web 输入/输出
// ============================================================================

/** derive-web 选项 */
export interface DeriveWebOptions {
  /** 项目根目录 */
  rootDir: string;
  /** 自定义 web/data.json 输出路径（默认 <rootDir>/web/data.json） */
  dataJsonPath?: string;
  /** 自定义站点工程路径（默认 <rootDir>/web） */
  webDir?: string;
  /** 自定义 VitePress build 产物目录（默认 <webDir>/.vitepress/dist） */
  distDir?: string;
  /** 是否执行 VitePress build（默认 true；测试时可关） */
  buildSite?: boolean;
  /** 站点工程模板目录（默认内置 web/ 模板） */
  templateDir?: string;
  /** 是否覆盖已存在产物（默认 false：提示先清掉） */
  force?: boolean;
}

export interface DeriveWebResult {
  /** WebDataJson（结构化中间表示） */
  data: WebDataJson;
  /** web/data.json 绝对路径 */
  dataJsonPath: string;
  /** 站点工程目录 */
  webDir: string;
  /** VitePress build 产物目录（buildSite=true 且成功时填） */
  distDir: string;
  /** VitePress build 是否执行 */
  built: boolean;
  /** 警告 */
  warnings: string[];
}

// ============================================================================
// 安全边界常量
// ============================================================================

/** 敏感字段名清单（即使出现在 derived/*.json 中也不入 web 产物） */
export const SENSITIVE_FIELD_NAMES = new Set([
  'tokenEnv',
  'secretEnv',
  'passwordEnv',
  'keyEnv',
  'usernameEnv',
  'certPath',
  'keyPath',
  'caPath',
  'token',
  'secret',
  'password',
  'apiKey',
]);

/** 提示给读者的脱敏说明（web/data.json 顶部 redactionNotice 字段） */
export const REDACTION_NOTICE_LINES = [
  '本产物由 derive-web 机械生成；不含 authConfig.token/secret/password 等敏感字段。',
  '本产物不读取 bindings.yaml；不读取进程环境变量。',
  'P0 范围仅只读展示；编辑能力在 P1 提供。',
];

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 过滤敏感字段：从对象中递归**删除**敏感字段名（深度优先）
 *
 * E7-I6 修复：与验收口径"tokenEnv 等字段不出现"严格对齐——
 * 整键删除，不替换为 [REDACTED]（避免键名本身暴露"存在某个令牌环境变量"）。
 *
 * 防御性：即使上游不慎写入敏感字段名，本步骤也会删除。
 * 验收 test 注入 SECRET_TOKEN_XYZ 类键名后能命中此函数。
 */
export function redactSensitiveFields<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map((v) => redactSensitiveFields(v)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_FIELD_NAMES.has(k)) {
      // E7-I6 修复：整键删除（而非替换为 [REDACTED]）
      continue;
    }
    out[k] = redactSensitiveFields(v);
  }
  return out as T;
}

/** 状态机图：mermaid stateDiagram-v2 源码 */
export function buildMermaidStateMachine(model: SourceProtocolModel): string {
  const lines: string[] = ['stateDiagram-v2'];
  // 初始状态 + 终态标识
  const initialId = model.derivable.initialStateId;
  for (const s of model.derivable.states) {
    let label = `${s.id}: ${s.name}`;
    if (s.type === 'terminal') label += ' (终态)';
    if (s.id === initialId) label += ' (初始)';
    lines.push(`    ${s.id} : ${label}`);
  }
  // 转移边：from → to : action[guard]
  for (const t of model.derivable.transitions) {
    for (const from of t.from) {
      const action = t.action ?? t.name;
      const guard = t.guard ? `[${t.guard}]` : '';
      lines.push(`    ${from} --> ${t.to} : ${action}${guard}`);
    }
  }
  return lines.join('\n');
}

/** 摘要派生：diff → 人读文本（最多 200 字符） */
export function summarizeDiff(diff: ModelDiff): string {
  const parts: string[] = [];
  if (diff.metadataChanges.length > 0) {
    parts.push(`元数据 ${diff.metadataChanges.length} 项变更`);
  }
  if (diff.readableChanges.length > 0) {
    parts.push(`可读层 ${diff.readableChanges.length} 项变更`);
  }
  if (diff.derivableChanges.length > 0) {
    parts.push(`可推演层 ${diff.derivableChanges.length} 项变更`);
  }
  return parts.length > 0 ? parts.join('；') : '无变更';
}

/** 影响分析 → 人读视图（变更元素 ID → 受影响步骤/产物） */
export function humanReadableImpact(
  diff: ModelDiff,
  impact: ImpactAnalysis
): Array<{ trigger: string; affected: string[] }> {
  const result: Array<{ trigger: string; affected: string[] }> = [];
  // 每个 added/removed 元素都是一个 trigger
  for (const c of diff.derivableChanges) {
    if (c.kind === 'added') {
      result.push({
        trigger: `新增 ${c.elementType}: ${c.elementId}`,
        affected: impact.affectedSteps.slice(),
      });
    } else if (c.kind === 'removed') {
      result.push({
        trigger: `删除 ${c.elementType}: ${c.elementId}`,
        affected: impact.affectedSteps.slice(),
      });
    } else if (c.kind === 'modified') {
      result.push({
        trigger: `变更 ${c.elementType}: ${c.elementId}`,
        affected: impact.affectedSteps.slice(),
      });
    }
  }
  return result;
}

// ============================================================================
// 视图构造器（pure functions；可独立测试）
// ============================================================================

/** InterfaceSpec[] → WebInterfaceView[] */
export function buildInterfaceViews(specs: InterfaceSpec[]): WebInterfaceView[] {
  return specs.map((s) => {
    const view: WebInterfaceView = {
      id: s.id,
      name: s.name,
      kind: s.kind,
      description: s.precondition ?? s.name,
      requestSchema: s.requestSchema,
      responseSchema: s.responseSchema,
      inputs: s.inputs,
      outputs: s.outputs,
      precondition: s.precondition,
      postconditions: s.postconditions ?? [],
      preconditions: s.preconditions,
      postconditionExpressions: s.postconditionExpressions,
      sideEffects: s.sideEffects,
      schemaKind: s.schemaKind,
      schemaDegradedReasons: s.schemaDegradedReasons,
      invariantIds: s.invariantIds,
      observesResourcePoolId: s.observesResourcePoolId,
    };
    if (s.actionType) view.actionType = s.actionType;
    return view;
  });
}

/** ProtocolPath[] → WebTestCaseView[]（合并 verification-report.json caseResults） */
export function buildTestCaseViews(
  testCases: TestCaseSet | undefined,
  verification: VerificationReport | undefined
): WebTestCaseView[] {
  if (!testCases) return [];
  // 用 pathId → CaseResult 索引
  const caseIndex = new Map<string, { passed: boolean; skipped?: boolean; deviations?: NonNullable<typeof verification>['authoritative']['caseResults'][0]['deviations'] }>();
  if (verification?.authoritative.caseResults) {
    for (const cr of verification.authoritative.caseResults) {
      caseIndex.set(cr.pathId, {
        passed: cr.passed,
        skipped: cr.skipped,
        deviations: cr.deviations,
      });
    }
  }
  return testCases.paths.map((p) => {
    const cr = caseIndex.get(p.id);
    const view: WebTestCaseView = {
      id: p.id,
      length: p.length,
      stateIds: p.stateIds,
      transitionIds: p.transitionIds,
      description: p.description,
      hasException: p.hasException,
      deviations: [],
    };
    if (cr) {
      view.verificationPassed = cr.passed;
      view.verificationSkipped = cr.skipped;
      if (cr.deviations) {
        view.deviations = cr.deviations.map((d) => ({
          action: d.action,
          state: d.state,
          kind: d.kind,
          expected: d.expected,
          actual: d.actual,
          field: d.field,
          legacy: d.legacy,
          impl: d.impl,
        }));
      }
    }
    return view;
  });
}

/** VerificationReport → WebVerificationView */
export function buildVerificationView(
  verification: VerificationReport | undefined
): WebVerificationView {
  if (!verification) {
    return {
      hasReport: false,
      passed: false,
      counts: { passed: 0, failed: 0, skipped: 0 },
      deviationSummary: {
        stateMismatch: 0,
        fieldMismatch: 0,
        missingAction: 0,
        invariantViolation: 0,
        timingViolation: 0,
        other: 0,
      },
      sideBySide: [],
    };
  }
  const summary = {
    stateMismatch: 0,
    fieldMismatch: 0,
    missingAction: 0,
    invariantViolation: 0,
    timingViolation: 0,
    other: 0,
  };
  const sideBySide: WebVerificationView['sideBySide'] = [];
  for (const cr of verification.authoritative.caseResults) {
    for (const d of cr.deviations ?? []) {
      if (d.kind === 'state_mismatch') summary.stateMismatch++;
      else if (d.kind === 'field_mismatch') summary.fieldMismatch++;
      else if (d.kind === 'missing_action') summary.missingAction++;
      else if (d.kind === 'invariant_violation') summary.invariantViolation++;
      else if (d.kind === 'timing_violation') summary.timingViolation++;
      else summary.other++;
      // 双跑对账：field_mismatch 时填 legacy/impl；state_mismatch 时填 expected/actual
      sideBySide.push({
        action: d.action,
        state: d.state,
        field: d.field ?? `state.${d.expected}`,
        legacy: d.legacy ?? d.expected,
        impl: d.impl ?? d.actual,
        matched: false,
      });
    }
  }
  return {
    hasReport: true,
    passed: verification.authoritative.passed,
    counts: verification.authoritative.counts,
    verifiedAt: verification.verifiedAt,
    deviationSummary: summary,
    sideBySide,
  };
}

/** ModelDiff → WebDiffView */
export function buildDiffView(
  diff: ModelDiff | undefined
): WebDiffView | null {
  if (!diff) return null;
  return {
    metadataChanges: diff.metadataChanges.map((c) => ({
      path: c.path,
      kind: c.kind,
      oldValue: c.oldValue,
      newValue: c.newValue,
    })),
    readableChanges: diff.readableChanges.map((c) => ({
      path: c.path,
      kind: c.kind,
      oldValue: c.oldValue,
      newValue: c.newValue,
    })),
    derivableChanges: diff.derivableChanges.map((c) => ({
      elementType: c.elementType,
      elementId: c.elementId,
      kind: c.kind,
      fieldChanges: c.fieldChanges?.map((fc) => ({
        path: fc.path,
        kind: fc.kind,
        oldValue: fc.oldValue,
        newValue: fc.newValue,
      })),
    })),
    diffedAt: diff.diffedAt,
    summary: summarizeDiff(diff),
  };
}

/** ImpactAnalysis + ModelDiff → WebImpactView */
export function buildImpactView(
  impact: ImpactAnalysis | undefined,
  diff: ModelDiff | undefined
): WebImpactView | null {
  if (!impact) return null;
  return {
    affectedSteps: impact.affectedSteps,
    affectedArtifacts: impact.affectedArtifacts,
    incrementalPlan: impact.incrementalPlan,
    analyzedAt: impact.analyzedAt,
    humanReadable: diff ? humanReadableImpact(diff, impact) : [],
  };
}

/** ImplCheckReport → WebImplCheckView */
export function buildImplCheckView(
  report: ImplCheckReport | undefined
): WebImplCheckView | null {
  if (!report) return null;
  const found = report.interfaceChecks.filter((c) => c.found).length;
  const missing = report.interfaceChecks.filter((c) => !c.found);
  return {
    hasReport: true,
    passed: report.passed,
    total: report.interfaceChecks.length,
    found,
    missing: missing.length,
    missingActions: missing.map((c) => {
      const out: { interfaceId: string; interfaceName: string; location?: string } = {
        interfaceId: c.interfaceId,
        interfaceName: c.interfaceName,
      };
      if (c.location) out.location = c.location;
      return out;
    }),
  };
}

// ============================================================================
// 主构造器
// ============================================================================

export interface DeriveWebInputs {
  /** envelope 形态 specs.json（必有） */
  specsEnvelope: SpecsEnvelope;
  /** model.md（必有；仅取元数据 + 状态机） */
  model: SourceProtocolModel;
  /** test-cases.json（可选） */
  testCases?: TestCaseSet;
  /** verification-report.json（可选） */
  verification?: VerificationReport;
  /** impl-check-report.json（可选） */
  implCheck?: ImplCheckReport;
  /** model-diff.json（可选） */
  diff?: ModelDiff;
  /** impact-analysis.json（可选） */
  impact?: ImpactAnalysis;
}

/** 由 inputs 构造 WebDataJson（pure function） */
export function buildWebData(inputs: DeriveWebInputs): WebDataJson {
  const { specsEnvelope, model, testCases, verification, implCheck, diff, impact } = inputs;
  const interfaces = buildInterfaceViews(specsEnvelope.specs);
  const testCaseViews = buildTestCaseViews(testCases, verification);
  const verificationView = buildVerificationView(verification);
  const diffView = buildDiffView(diff);
  const impactView = buildImpactView(impact, diff);
  const implCheckView = buildImplCheckView(implCheck);
  return {
    schemaVersion: WEB_DATA_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceModelVersion: model.metadata.version,
    protocol: {
      name: model.metadata.name,
      version: model.metadata.version,
      purpose: model.metadata.purpose,
      roles: model.metadata.roles.map((r) => {
        const o: { id: string; name: string; roleType?: string } = { id: r.id, name: r.name };
        if (r.roleType) o.roleType = r.roleType;
        return o;
      }),
    },
    interfaces,
    testCases: testCaseViews,
    verification: verificationView,
    diff: diffView,
    impact: impactView,
    implCheck: implCheckView,
    stateMachine: { mermaid: buildMermaidStateMachine(model) },
    redactionNotice: REDACTION_NOTICE_LINES,
  };
}

// ============================================================================
// 文件 I/O
// ============================================================================

/**
 * 读取 derived/*.json（不存在返回 undefined；不抛错）
 *
 * 防御性：JSON.parse 失败时返回 undefined（CLI 不阻断；warnings 报告）
 *
 * E7-I7 修复：调用方可通过 readOptionalJsonWithStatus 区分
 * "missing"（未找到）vs "corrupt"（JSON 解析失败）。
 */
export function readOptionalJson<T>(path: string): T | undefined {
  return readOptionalJsonWithStatus<T>(path).value;
}

/** E7-I7 修复：带状态返回，区分 missing vs corrupt */
export function readOptionalJsonWithStatus<T>(
  path: string
): { value: T | undefined; status: 'missing' | 'corrupt' | 'ok'; error?: string } {
  if (!existsSync(path)) return { value: undefined, status: 'missing' };
  try {
    return { value: JSON.parse(readFileSync(path, 'utf-8')) as T, status: 'ok' };
  } catch (err) {
    return {
      value: undefined,
      status: 'corrupt',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 写 JSON（确保目录存在） */
export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

/** 写文本 */
export function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

// ============================================================================
// VitePress 页面生成（.md）
// ============================================================================

/** 渲染 Markdown 表格（人读） */
function renderTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '*(无)*';
  const lines: string[] = [];
  lines.push(`| ${headers.join(' | ')} |`);
  lines.push(`| ${headers.map(() => '---').join(' | ')} |`);
  for (const r of rows) {
    lines.push(`| ${r.map((c) => String(c).replace(/\|/g, '\\|')).join(' | ')} |`);
  }
  return lines.join('\n');
}

/** 渲染 JSON Schema 为人读表格（properties 列表） */
function renderSchemaTable(schema: JSONSchema | undefined): string {
  if (!schema?.properties) return '*(无 schema)*';
  const rows = Object.entries(schema.properties).map(([k, v]) => {
    const required = schema.required?.includes(k) ? '✓' : '';
    return [k, v.type ?? 'any', v.description ?? '', required];
  });
  return renderTable(['字段', '类型', '说明', '必填'], rows);
}

/** 生成首页 index.md */
function renderIndexPage(data: WebDataJson): string {
  const { protocol, interfaces, testCases, verification } = data;
  const sysCount = interfaces.filter((i) => i.kind === 'system').length;
  const obsCount = interfaces.filter((i) => i.kind === 'observation').length;
  const passed = verification.counts.passed;
  const failed = verification.counts.failed;
  return `# ${protocol.name}

> 协议版本：**${protocol.version}** | 检阅时间：${data.generatedAt}

${protocol.purpose}

## 总览

| 指标 | 值 |
| --- | --- |
| 角色数 | ${protocol.roles.length} |
| 系统接口 | ${sysCount} |
| 观测接口 | ${obsCount} |
| 测试用例 | ${testCases.length} |
| 验证通过 / 失败 | ${passed} / ${failed} |

## 快速跳转

- [接口列表](interfaces/) — ${interfaces.length} 个接口的请求/响应结构与守卫
- [测试用例浏览器](test-cases) — 路径覆盖度与偏差
- [验证报告对比](verification) — legacy vs impl 双跑对账
- [模型 diff / impact](diff) — 变更 → 受影响步骤/产物

## 状态机图（mermaid）

\`\`\`mermaid
${data.stateMachine.mermaid}
\`\`\`

> 复制上述 mermaid 段落到 <https://mermaid.live> 可渲染。

## 角色

${renderTable(
  ['ID', '名称', '类型'],
  protocol.roles.map((r) => [r.id, r.name, r.roleType ?? '—']),
)}

## 安全边界

${data.redactionNotice.map((n) => `- ${n}`).join('\n')}
`;
}

/** 生成接口列表 index.md（interfaces/index.md） */
function renderInterfacesIndexPage(data: WebDataJson): string {
  const rows = data.interfaces.map((i) => {
    const kindLabel = i.kind === 'system' ? '系统' : '观测';
    const actionType = i.actionType ?? (i.kind === 'observation' ? 'observe' : 'state_transition');
    const schemaKind = i.schemaKind ?? '—';
    return [
      `[${i.id}](${i.id})`,
      i.name,
      kindLabel,
      actionType,
      schemaKind,
    ];
  });
  return `# 接口列表

> 共 ${data.interfaces.length} 个接口（系统 ${data.interfaces.filter((i) => i.kind === 'system').length} + 观测 ${data.interfaces.filter((i) => i.kind === 'observation').length}）

${renderTable(['ID', '名称', '类型', '动作类型', 'schemaKind'], rows)}
`;
}

/** 生成单个接口详情 .md */
function renderInterfaceDetailPage(view: WebInterfaceView): string {
  const parts: string[] = [];
  parts.push(`# ${view.name}\n`);
  parts.push(`> 接口 ID: \`${view.id}\` | 类型: **${view.kind === 'system' ? '系统' : '观测'}**${
    view.actionType ? ` | 动作类型: \`${view.actionType}\`` : ''
  } | schemaKind: **${view.schemaKind ?? '—'}**\n`);
  if (view.schemaDegradedReasons && view.schemaDegradedReasons.length > 0) {
    parts.push('## 降级理由\n');
    for (const r of view.schemaDegradedReasons) parts.push(`- ${r}`);
    parts.push('');
  }
  parts.push('## 请求参数 (requestSchema)\n');
  parts.push(renderSchemaTable(view.requestSchema));
  parts.push('');
  parts.push('## 响应体 (responseSchema)\n');
  parts.push(renderSchemaTable(view.responseSchema));
  parts.push('');
  if (view.preconditions && view.preconditions.length > 0) {
    parts.push('## 前置条件 (preconditions)\n');
    for (const p of view.preconditions) {
      parts.push(`- kind=\`${p.kind}\`：${p.description ?? ''}${p.schema ? ` / schema=${JSON.stringify(p.schema)}` : ''}`);
    }
    parts.push('');
  }
  if (view.postconditionExpressions && view.postconditionExpressions.length > 0) {
    parts.push('## 后置条件 (postconditionExpressions)\n');
    for (const p of view.postconditionExpressions) {
      parts.push(`- ${p.description ?? p.kind}`);
    }
    parts.push('');
  }
  if (view.postconditions && view.postconditions.length > 0) {
    parts.push('## 副作用描述 (postconditions)\n');
    for (const p of view.postconditions) parts.push(`- ${p}`);
    parts.push('');
  }
  if (view.invariantIds && view.invariantIds.length > 0) {
    parts.push('## 关联不变量\n');
    for (const id of view.invariantIds) parts.push(`- ${id}`);
    parts.push('');
  }
  return parts.join('\n');
}

/** 生成 test-cases.md */
function renderTestCasesPage(data: WebDataJson): string {
  const rows = data.testCases.map((tc) => {
    const passed = tc.verificationPassed === true ? '✓' : tc.verificationPassed === false ? '✗' : '?';
    const skipped = tc.verificationSkipped ? '(跳过)' : '';
    const deviations = tc.deviations.length;
    return [
      tc.id,
      String(tc.length),
      tc.stateIds.join(' → '),
      tc.transitionIds.join(','),
      tc.hasException ? '是' : '否',
      `${passed}${skipped}`,
      String(deviations),
    ];
  });
  return `# 测试用例浏览器

> 共 ${data.testCases.length} 条路径用例。

${renderTable(
  ['ID', '长度', '状态序列', '转移序列', '含异常', '验证', '偏差数'],
  rows,
)}

## 偏差详情（按用例分组）

${data.testCases
  .filter((tc) => tc.deviations.length > 0)
  .map((tc) => {
    const devTable = renderTable(
      ['动作', '状态', '类型', '期望', '实际', '字段'],
      tc.deviations.map((d) => [d.action, d.state, d.kind, d.expected, d.actual, d.field ?? '—']),
    );
    return `### ${tc.id}\n\n${devTable}`;
  })
  .join('\n\n') || '*（所有用例均无偏差）*'}
`;
}

/** 生成 verification.md */
function renderVerificationPage(data: WebDataJson): string {
  const v = data.verification;
  const s = v.deviationSummary;
  const rows: string[][] = [];
  rows.push(['state_mismatch', String(s.stateMismatch)]);
  rows.push(['field_mismatch', String(s.fieldMismatch)]);
  rows.push(['missing_action', String(s.missingAction)]);
  rows.push(['invariant_violation', String(s.invariantViolation)]);
  rows.push(['timing_violation', String(s.timingViolation)]);
  rows.push(['other', String(s.other)]);
  const sbRows = v.sideBySide.map((r) => [
    r.action,
    r.state,
    r.field,
    r.legacy,
    r.impl,
    r.matched ? '✓' : '✗',
  ]);
  return `# 验证报告对比（legacy vs impl）

> 报告是否可用：${v.hasReport ? '是' : '否'} | 总体：${v.passed ? '✓ 通过' : '✗ 未通过'}
> 通过 / 失败 / 跳过：${v.counts.passed} / ${v.counts.failed} / ${v.counts.skipped}
${v.verifiedAt ? `> 验证时间：${v.verifiedAt}\n` : ''}

## 偏差分类统计

${renderTable(['类型', '数量'], rows)}

## 双跑对账（legacy vs impl 并排）

${renderTable(
  ['动作', '状态', '字段', 'legacy', 'impl', '一致'],
  sbRows,
)}
`;
}

/** 生成 diff.md */
function renderDiffPage(data: WebDataJson): string {
  const d = data.diff;
  const i = data.impact;
  if (!d) {
    return `# 模型 diff / impact

> 未检测到 model-diff.json（请先运行 \`protochain diff\`）。

如需触发差异，运行：

\`\`\`bash
protochain version save
# 改 model.md
protochain version save
protochain diff
protochain derive-web
\`\`\`
`;
  }
  const mdRows = d.metadataChanges.map((c) => [c.path, c.kind, c.oldValue ?? '—', c.newValue ?? '—']);
  const rdRows = d.readableChanges.map((c) => [c.path, c.kind, c.oldValue ?? '—', c.newValue ?? '—']);
  const drRows = d.derivableChanges.map((c) => [c.elementType, c.elementId, c.kind]);
  return `# 模型 diff / impact

> 摘要：${d.summary}
> 差分时间：${d.diffedAt}

## 元数据层变更

${renderTable(['路径', '类型', '旧值', '新值'], mdRows)}

## 可读层变更

${renderTable(['路径', '类型', '旧值', '新值'], rdRows)}

## 可推演层变更

${renderTable(['元素类型', '元素 ID', '类型'], drRows)}

${
  i
    ? `## 影响分析

> 分析时间：${i.analyzedAt}

### 受影响步骤

${i.affectedSteps.length > 0 ? i.affectedSteps.map((s) => `- ${s}`).join('\n') : '*（无）*'}

### 受影响产物

${i.affectedArtifacts.length > 0 ? i.affectedArtifacts.map((s) => `- ${s}`).join('\n') : '*（无）*'}

### 增量重推导路径

${i.incrementalPlan.length > 0 ? i.incrementalPlan.join(' → ') : '*（无）*'}

### 人读映射（变更 → 受影响步骤）

${
  i.humanReadable.length > 0
    ? i.humanReadable
        .map(
          (h) => `- **${h.trigger}** → ${h.affected.length > 0 ? h.affected.join(', ') : '(无)'}`
        )
        .join('\n')
    : '*（无）*'
}
`
    : ''
}
`;
}

// ============================================================================
// VitePress 配置文件生成
// ============================================================================

/** 生成 VitePress config.ts（站点工程配置） */
function renderVitePressConfig(): string {
  return `import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Protochain Review',
  description: '协议驱动自验证工具链 — 模型检阅界面',
  cleanUrls: true,
  srcDir: '.',
  ignoreDeadLinks: true,
  // 不启用搜索框的索引构建（保持构建轻量）
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '接口', link: '/interfaces/' },
      { text: '测试用例', link: '/test-cases' },
      { text: '验证报告', link: '/verification' },
      { text: 'diff/impact', link: '/diff' },
    ],
    sidebar: [
      {
        text: '接口',
        items: [{ text: '列表', link: '/interfaces/' }],
      },
      {
        text: '检阅',
        items: [
          { text: '测试用例', link: '/test-cases' },
          { text: '验证报告', link: '/verification' },
          { text: 'diff/impact', link: '/diff' },
        ],
      },
    ],
    socialIcons: [],
    footer: {
      message: '由 protochain derive-web 机械生成',
      copyright: 'Generated at ' + new Date().toISOString(),
    },
  },
});
`;
}

/** 生成 web/package.json（站点工程独立；vitepress 仅 devDep） */
function renderWebPackageJson(): string {
  return JSON.stringify(
    {
      name: 'protochain-web',
      version: '0.1.0',
      private: true,
      type: 'module',
      description: 'Protochain Web 检阅界面（VitePress 站点）',
      scripts: {
        'docs:dev': 'vitepress dev docs',
        'docs:build': 'vitepress build docs',
        'docs:preview': 'vitepress preview docs',
      },
      devDependencies: {
        vitepress: '^1.6.3',
      },
    },
    null,
    2,
  );
}

// ============================================================================
// 主入口
// ============================================================================

/**
 * 推导出 web 站点数据 + 静态页面（CLI 入口）
 *
 * 不直接执行 VitePress build；由 caller 决定是否调 buildSite。
 * 若 buildSite=true → spawnSync npx vitepress build。
 */
export async function deriveWeb(
  options: DeriveWebOptions,
  parseModel: (rootDir: string) => SourceProtocolModel
): Promise<DeriveWebResult> {
  const rootDir = options.rootDir;
  const dataJsonPath = options.dataJsonPath ?? join(rootDir, 'web/data.json');
  const webDir = options.webDir ?? join(rootDir, 'web');
  const docsDir = join(webDir, 'docs');
  const publicDir = join(docsDir, 'public');
  const interfacesDir = join(docsDir, 'interfaces');
  const distDir = options.distDir ?? join(docsDir, '.vitepress/dist');

  const warnings: string[] = [];

  // 1. 读取 specs.json（Envelope 形态）
  const specsPath = join(rootDir, 'derived/specs.json');
  if (!existsSync(specsPath)) {
    throw new Error(
      `specs.json 不存在: ${specsPath}（请先运行 protochain derive-specs）`
    );
  }
  const rawSpecs = JSON.parse(readFileSync(specsPath, 'utf-8')) as unknown;
  let envelope: SpecsEnvelope;
  if (isSpecsEnvelope(rawSpecs)) {
    envelope = rawSpecs;
  } else if (Array.isArray(rawSpecs)) {
    // 老格式 → 自动 migrate
    const r = envelopeMigrate(rawSpecs, 'unknown');
    for (const w of r.warnings) warnings.push(`[specs.json] ${w}`);
    envelope = r.envelope;
  } else {
    throw new Error('specs.json 形态无法识别（既不是 Envelope 也不是裸数组）');
  }

  // 2. 读取 model.md（仅取元数据 + 状态机）
  const model = parseModel(rootDir);

  // 3. 读取可选产物（E7-I7 修复：区分 missing vs corrupt）
  const tcR = readOptionalJsonWithStatus<TestCaseSet>(join(rootDir, 'derived/test-cases.json'));
  const vfR = readOptionalJsonWithStatus<VerificationReport>(join(rootDir, 'derived/verification/verification-report.json'));
  const icR = readOptionalJsonWithStatus<ImplCheckReport>(join(rootDir, 'derived/impl-check/impl-check-report.json'));
  const dfR = readOptionalJsonWithStatus<ModelDiff>(join(rootDir, 'derived/diff/model-diff.json'));
  const imR = readOptionalJsonWithStatus<ImpactAnalysis>(join(rootDir, 'derived/impact-analysis.json'));
  const testCases = tcR.value;
  const verification = vfR.value;
  const implCheck = icR.value;
  const diff = dfR.value;
  const impact = imR.value;
  for (const [name, r] of [
    ['derived/test-cases.json', tcR] as const,
    ['derived/verification/verification-report.json', vfR] as const,
    ['derived/impl-check/impl-check-report.json', icR] as const,
    ['derived/diff/model-diff.json', dfR] as const,
    ['derived/impact-analysis.json', imR] as const,
  ]) {
    if (r.status === 'missing') {
      const msg =
        name === 'derived/diff/model-diff.json'
          ? `未找到 ${name}；diff 页将显示"无差异"`
          : `未找到 ${name}；对应页面将空`;
      warnings.push(msg);
    } else if (r.status === 'corrupt') {
      warnings.push(`${name} 存在但 JSON 解析失败（${r.error}）；对应页面将空`);
    }
  }

  // 4. 构造 WebDataJson
  let data = buildWebData({
    specsEnvelope: envelope,
    model,
    testCases,
    verification,
    implCheck,
    diff,
    impact,
  });

  // 5. 防御性：redact sensitive fields（即使上游不慎写入）
  data = redactSensitiveFields(data) as WebDataJson;

  // E7-I8 修复：--force 检查（在所有写出之前；已存在产物时未传 force → 抛错）
  if (!options.force && existsSync(dataJsonPath)) {
    throw new Error(
      `web 产物已存在（${dataJsonPath}）；如需覆盖请传 --force`
    );
  }

  // 6. 写出 web/data.json
  writeJson(dataJsonPath, data);
  // 7. 写出 web/docs/public/data.json（站点工程副本）
  writeJson(join(publicDir, 'data.json'), data);

  // 8. 写出 VitePress 站点配置
  mkdirSync(join(docsDir, '.vitepress'), { recursive: true });
  writeText(join(docsDir, '.vitepress/config.ts'), renderVitePressConfig());

  // 9. 写出 web/package.json（站点工程独立）
  writeText(join(webDir, 'package.json'), renderWebPackageJson());

  // 10. 写出页面 .md
  writeText(join(docsDir, 'index.md'), renderIndexPage(data));
  mkdirSync(interfacesDir, { recursive: true });
  writeText(join(interfacesDir, 'index.md'), renderInterfacesIndexPage(data));
  for (const view of data.interfaces) {
    writeText(join(interfacesDir, `${view.id}.md`), renderInterfaceDetailPage(view));
  }
  writeText(join(docsDir, 'test-cases.md'), renderTestCasesPage(data));
  writeText(join(docsDir, 'verification.md'), renderVerificationPage(data));
  writeText(join(docsDir, 'diff.md'), renderDiffPage(data));

  // 11. VitePress build（spawnSync npx；不强制成功，失败时 warnings 报告）
  let built = false;
  if (options.buildSite !== false) {
    const { spawnSync } = await import('node:child_process');
    const cmd = `npx --yes vitepress build docs`;
    const result = spawnSync(cmd, {
      cwd: webDir,
      encoding: 'utf-8',
      shell: true,
      timeout: 180000,
    });
    if (result.status !== 0) {
      warnings.push(
        `vitepress build 退出码 ${result.status}（stderr: ${(result.stderr ?? '').slice(0, 500)}）`
      );
    } else if (existsSync(join(distDir, 'index.html'))) {
      built = true;
    } else {
      warnings.push(`vitepress build 完成但未产出 dist/index.html（cwd=${webDir}）`);
    }
  }

  return {
    data,
    dataJsonPath,
    webDir,
    distDir,
    built,
    warnings,
  };
}