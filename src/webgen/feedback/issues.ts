/**
 * 反馈闭环：评审标注 → 工具链修改单草稿 —— E7-P1
 *
 * 设计依据：
 *   - IMPLEMENTATION-PLAN.md §E7 P1 §「评审标注 → 生成工具链修改单草稿（走 M→D→B→I→V→R，不绕过流程）」
 *   - /work/工具链修改单-模板.md / /work/工具链修改单-README.md
 *
 * 行为：
 *   - 用户在 Web 端对 model.md / specs.json / test-cases.json / verify-report 提交评审
 *   - 服务合并评审 → 走「建议修改单」草稿（草稿落 /work/，文件名按 NNN 编号）
 *   - 评审内容不直接注入 model / specs / verify；不改权威源
 *   - 草稿只写到 /work，**不**自提交；按现有流程由人工/审阅者走"待审阅 → 已采纳 → 已提交 → 已修复"
 *
 * 草稿形态（与现有 001/002/003 同款）：
 *   - 文件名：`/work/工具链修改单-NNN-protochain-<slug>.md`
 *   - NNN 自动取下一个未被占用编号
 *   - slug 由评审短标题生成
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const WORK_DIR = '/work';
const TEMPLATE_PATH = join(WORK_DIR, '工具链修改单-模板.md');
const README_PATH = join(WORK_DIR, '工具链修改单-README.md');

export interface ReviewComment {
  /** 评审对象：model / specs / test-cases / verification / interface / scenario 等 */
  target: string;
  /** 元素 ID（接口 ID / scenario ID / 不变量 ID / 转移 ID 等） */
  elementId: string;
  /** 问题类型：bug | doc | api-design | coverage | other */
  category: 'bug' | 'doc' | 'api-design' | 'coverage' | 'other';
  /** 严重度：P0-24h | P1-7d | P2-30d（来自 E10 模板） */
  severity: 'P0-24h' | 'P1-7d' | 'P2-30d';
  /** 标题（一句话） */
  title: string;
  /** 现象 + 证据 */
  body: string;
  /** 提交者（人/实例） */
  author: string;
  /** 影响范围（自由文本） */
  impact?: string;
  /** 建议修改（自由文本） */
  suggestion?: string;
}

export interface DraftIssueResult {
  ok: boolean;
  draftPath?: string;
  number?: number;
  error?: string;
}

/**
 * 取下一个 NNN：扫 /work/工具链修改单-*.md，取最大编号 + 1；000 占位
 */
export function nextIssueNumber(): number {
  if (!existsSync(WORK_DIR)) return 1;
  const files = readdirSync(WORK_DIR).filter((f) => /^工具链修改单-\d{3}-.+\.md$/.test(f));
  let max = 0;
  for (const f of files) {
    const m = /工具链修改单-(\d{3})-/.exec(f);
    if (m) {
      const n = Number(m[1]);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

/** 转 slug：把标题里的非 ASCII / 空格 / 标点替换为 '-'，连续合并 */
export function slugify(title: string): string {
  const ascii = title
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  if (ascii) return ascii.slice(0, 40) || 'issue';
  // 全中文/非 ASCII 用 hash + 短码
  const fallback = `issue-${(Math.abs(hashStr(title))).toString(36)}`;
  return fallback.slice(0, 40);
}

/** 简单字符串哈希（仅用于 slug） */
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h;
}

/**
 * 把评审记录渲染为修改单草稿 Markdown。
 *
 * 默认文件名 `工具链修改单-<NNN>-protochain-<slug>.md`；状态="待审阅"。
 */
export function renderDraftIssue(
  nnn: number,
  review: ReviewComment,
  ctx: { rootDir: string; instanceName: string; protocolId?: string; toolsSha?: string | null }
): string {
  const today = new Date().toISOString().slice(0, 10);
  const toolsSha = ctx.toolsSha ?? tryGetGitSha();
  const lines: string[] = [];
  lines.push(`# 工具链修改单 ${String(nnn).padStart(3, '0')}：${review.title}`);
  lines.push('');
  lines.push(`- 工具链仓库：protochain`);
  lines.push(`- 提出日期：${today}`);
  lines.push(`- 提出方：${ctx.instanceName}${review.author ? `（${review.author}）` : ''}（由 P1 反馈闭环编辑器生成；与具体工程实例无关）`);
  lines.push(`- 状态：待审阅（流转：待审阅 → 已采纳 → 已提交 → 已修复）`);
  if (ctx.protocolId) lines.push(`- 触发实例子协议：${ctx.protocolId}`);
  if (toolsSha) lines.push(`- 工具链 commit：${toolsSha}`);
  lines.push('');
  lines.push('## 问题（现象 + 证据）');
  lines.push('');
  lines.push(`评审对象：\`${review.target}\``);
  if (review.elementId) lines.push(`元素 ID：\`${review.elementId}\``);
  lines.push(`类别：\`${review.category}\` | 严重度：\`${review.severity}\``);
  lines.push('');
  lines.push(review.body.trim());
  lines.push('');
  lines.push('### 触发实例与上下文');
  lines.push('');
  lines.push(`- 实例根：${ctx.rootDir}`);
  lines.push(`- 实例名：${ctx.instanceName}`);
  if (ctx.protocolId) lines.push(`- 子协议：${ctx.protocolId}`);
  lines.push('');
  lines.push('## 影响');
  lines.push('');
  lines.push(review.impact?.trim() || '（待审阅时确认）');
  lines.push('');
  lines.push('## 建议修改（仓库内改动点）');
  lines.push('');
  lines.push(review.suggestion?.trim() || '（待审阅时确认）');
  lines.push('');
  lines.push('## 验收（工具链自身测试）');
  lines.push('');
  lines.push('- `cd /work/protochain && npx tsc --noEmit && npx jest`：全绿');
  lines.push('- 修复后由提出方按实例流程跑回归（不强求修改单内复测）；');
  lines.push('- 此修改单的评审对象（`' + review.target + '`' + (review.elementId ? ` / ${review.elementId}` : '') + '）修复后不出现回归。');
  lines.push('');
  lines.push('## 审阅记录（用户填写）');
  lines.push('');
  lines.push('- 审阅结论：待审阅 / 已采纳 / 拒绝 / 已提交');
  lines.push('- 提交 hash：');
  lines.push('- 验证结果：');
  lines.push('- 备注：');
  lines.push('');
  return lines.join('\n');
}

/**
 * 写修改单草稿到 /work
 */
export function writeDraftIssue(
  review: ReviewComment,
  ctx: { rootDir: string; instanceName: string; protocolId?: string }
): DraftIssueResult {
  if (!existsSync(WORK_DIR)) return { ok: false, error: `工作目录不存在：${WORK_DIR}` };
  if (!existsSync(TEMPLATE_PATH)) return { ok: false, error: `模板不存在：${TEMPLATE_PATH}` };
  const nnn = nextIssueNumber();
  if (nnn > 999) return { ok: false, error: '修改单编号上限已满（NNN ≤ 999）' };
  const slug = slugify(review.title);
  const fname = `工具链修改单-${String(nnn).padStart(3, '0')}-protochain-${slug}.md`;
  const full = join(WORK_DIR, fname);
  if (existsSync(full)) return { ok: false, error: `草稿已存在：${fname}` };
  const body = renderDraftIssue(nnn, review, ctx);
  try {
    writeFileSync(full, body, 'utf-8');
    return { ok: true, draftPath: full, number: nnn };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 取当前 protochain 仓库的 git sha（短）；如果不在 git 仓库内则 null */
export function tryGetGitSha(repoRoot?: string): string | null {
  try {
    const cwd = repoRoot ?? WORK_DIR + '/../protochain';
    const r = execSync('git rev-parse --short HEAD', { cwd, encoding: 'utf-8' });
    return r.trim().split('\n')[0] ?? null;
  } catch {
    return null;
  }
}

/** 列出 /work 下所有"工具链修改单-*.md"，供前端展示历史草稿/已提交修改单 */
export function listIssues(): Array<{ nnn: number; path: string; slug: string; status: string }> {
  if (!existsSync(WORK_DIR)) return [];
  const files = readdirSync(WORK_DIR).filter((f) => /^工具链修改单-\d{3}-.+\.md$/.test(f));
  const items: Array<{ nnn: number; path: string; slug: string; status: string }> = [];
  for (const f of files) {
    const m = /^工具链修改单-(\d{3})-(.+)\.md$/.exec(f);
    if (!m) continue;
    const nnn = Number(m[1]);
    const slug = m[2];
    let status = '待审阅';
    try {
      const raw = readFileSync(join(WORK_DIR, f), 'utf-8');
      const sm = /状态[:：]\s*([^\n]+)/.exec(raw);
      if (sm) status = sm[1].trim();
    } catch {
      // 忽略读不到
    }
    items.push({ nnn, path: join(WORK_DIR, f), slug, status });
  }
  items.sort((a, b) => b.nnn - a.nnn);
  return items;
}

/** 校验评审对象（前端 form post 时调） */
export function validateReview(input: unknown): { ok: true; data: ReviewComment } | { ok: false; error: string } {
  if (!input || typeof input !== 'object') return { ok: false, error: 'body 必须是对象' };
  const r = input as Record<string, unknown>;
  const allowedCat = new Set(['bug', 'doc', 'api-design', 'coverage', 'other']);
  const allowedSev = new Set(['P0-24h', 'P1-7d', 'P2-30d']);
  if (typeof r.target !== 'string' || r.target.length === 0) return { ok: false, error: 'target 必填' };
  if (typeof r.elementId !== 'string') return { ok: false, error: 'elementId 必填（字符串）' };
  if (typeof r.category !== 'string' || !allowedCat.has(r.category)) {
    return { ok: false, error: 'category 必须是 bug/doc/api-design/coverage/other' };
  }
  if (typeof r.severity !== 'string' || !allowedSev.has(r.severity)) {
    return { ok: false, error: 'severity 必须是 P0-24h/P1-7d/P2-30d' };
  }
  if (typeof r.title !== 'string' || r.title.trim().length === 0) return { ok: false, error: 'title 必填' };
  if (typeof r.body !== 'string' || r.body.trim().length === 0) return { ok: false, error: 'body 必填' };
  if (typeof r.author !== 'string' || r.author.trim().length === 0) return { ok: false, error: 'author 必填' };
  const out: ReviewComment = {
    target: r.target,
    elementId: r.elementId,
    category: r.category as ReviewComment['category'],
    severity: r.severity as ReviewComment['severity'],
    title: r.title,
    body: r.body,
    author: r.author,
  };
  if (typeof r.impact === 'string') out.impact = r.impact;
  if (typeof r.suggestion === 'string') out.suggestion = r.suggestion;
  return { ok: true, data: out };
}
