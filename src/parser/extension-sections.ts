/**
 * 扩展段检测规则（parser 与 composition-parser 共用）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》2.1 节、决策8
 *
 * 决策8 区分两种可选语义：
 * - 段落级可选（语义A）：整个声明段（如资源池段、附属实体段）可以不存在。
 *   parser 按二级标题名匹配检测段落是否存在，checker 按启用情况调整检查项。
 * - 字段级必填（语义B）：一旦对应段落存在，段落内的扩展字段仍必填。
 *
 * 检测规则：
 * · 按标题名称匹配扩展段（如"## 资源池"/"## 附属实体"/"## 跨协议不变量"等）
 * · 检测到匹配标题 → 提取其下首个 YAML 代码块作为该段的结构化数据，段落标记为"已启用"
 * · 未检测到匹配标题 → 该扩展标记为"未启用"，对应类型字段置为空数组/undefined，checker 跳过该段的检查项
 * · 检测到标题但其下无 YAML 代码块 → 解析错误（段落声明存在但内容缺失）
 */

import { parse as parseYaml } from 'yaml';
import type { Section } from './markdown-ast.js';
import { findFirstCodeBlock } from './markdown-ast.js';
import { ParseError } from './markdown-ast.js';

// ----------------------------------------------------------------------------
// 扩展段检测结果
// ----------------------------------------------------------------------------

/**
 * 单个扩展段的检测结果。
 * - enabled=false 且 yaml=null：段落不存在（语义A，合法）
 * - enabled=true 且 yaml=非空：段落存在且提取到 YAML（正常）
 * - 抛出 ParseError：段落存在但无 YAML 代码块（声明存在但内容缺失）
 */
export interface ExtensionSectionDetection {
  /** 是否检测到该扩展段（段落级启用标志） */
  enabled: boolean;
  /** 提取的 YAML 解析结果（enabled=true 时非 null） */
  yaml: unknown | null;
  /** 匹配到的 section（enabled=true 时有值，便于上层定位） */
  section: Section | null;
}

// ----------------------------------------------------------------------------
// 标题匹配
// ----------------------------------------------------------------------------

/**
 * 判断 section 标题是否匹配指定关键词集合。
 * 匹配规则：标题规范化后包含任一关键词。
 *
 * @param section 待判断的 section
 * @param keywords 关键词集合（中文/英文别名，如 ['资源池', 'resourcepool']）
 */
export function matchSectionByKeywords(section: Section, keywords: string[]): boolean {
  for (const kw of keywords) {
    if (section.heading.includes(kw.toLowerCase())) return true;
  }
  return false;
}

/**
 * 在 sections 中查找首个匹配关键词的 section。
 */
export function findSectionByKeywords(
  sections: Section[],
  keywords: string[]
): Section | null {
  for (const section of sections) {
    if (matchSectionByKeywords(section, keywords)) return section;
  }
  return null;
}

// ----------------------------------------------------------------------------
// 扩展段检测主逻辑
// ----------------------------------------------------------------------------

/**
 * 检测单个扩展段：按关键词定位 section，提取其下首个 YAML 代码块。
 *
 * 决策8 三态：
 * - 段落不存在 → { enabled: false, yaml: null }
 * - 段落存在且有 YAML 块 → { enabled: true, yaml: <parsed> }
 * - 段落存在但无 YAML 块 → 抛 ParseError（声明存在但内容缺失）
 *
 * @param sections 全部 section 列表
 * @param keywords 扩展段标题关键词
 * @param sectionName 用于错误提示的段落名（如"资源池"）
 */
export function detectExtensionSection(
  sections: Section[],
  keywords: string[],
  sectionName: string
): ExtensionSectionDetection {
  const section = findSectionByKeywords(sections, keywords);
  if (!section) {
    return { enabled: false, yaml: null, section: null };
  }

  const codeBlock = findFirstCodeBlock(section.children, 'yaml');
  if (!codeBlock || !codeBlock.value) {
    throw new ParseError(
      `扩展段"${sectionName}"声明存在（标题：${section.headingRaw}），但其下缺少 YAML 代码块（段落声明存在但内容缺失）`,
      sectionName
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(codeBlock.value);
  } catch (err) {
    throw new ParseError(
      `扩展段"${sectionName}"的 YAML 代码块解析失败：${err instanceof Error ? err.message : String(err)}`,
      sectionName
    );
  }

  return { enabled: true, yaml: parsed, section };
}

/**
 * 批量检测多个扩展段，返回启用项的 YAML 数组。
 * 用于"每段一个对象"的声明（如资源池、附属实体）。
 *
 * @param sections 全部 section 列表
 * @param keywords 扩展段标题关键词
 * @param sectionName 段落名
 * @param itemParser 单项解析函数（YAML → T）
 */
export function detectExtensionSectionList<T>(
  sections: Section[],
  keywords: string[],
  sectionName: string,
  itemParser: (yaml: unknown, section: Section) => T
): T[] {
  const detection = detectExtensionSection(sections, keywords, sectionName);
  if (!detection.enabled) return [];
  const yaml = detection.yaml;
  if (!Array.isArray(yaml)) {
    throw new ParseError(
      `扩展段"${sectionName}"的 YAML 内容必须是数组`,
      sectionName
    );
  }
  return yaml.map((item, idx) => itemParser(item, detection.section!));
}

/**
 * 检测单个扩展段并解析为单个对象。
 * 用于"每段一个对象"的声明（如实例化声明）。
 */
export function detectExtensionSectionObject<T>(
  sections: Section[],
  keywords: string[],
  sectionName: string,
  objectParser: (yaml: unknown, section: Section) => T
): T | undefined {
  const detection = detectExtensionSection(sections, keywords, sectionName);
  if (!detection.enabled) return undefined;
  return objectParser(detection.yaml, detection.section!);
}

// ----------------------------------------------------------------------------
// 三级标题子项解析（composition.md 用：每条声明一个 ### 标题）
// ----------------------------------------------------------------------------

/**
 * 在指定父 section 的 children 中，按三级标题切分子 section，
 * 每个子 section 提取首个 YAML 代码块并解析。
 *
 * 用于 composition.md 的"每条声明一个三级标题"格式
 * （如跨协议不变量、观测接口、对象状态切面等）。
 *
 * @param parentSection 父 section（其 children 含 ### 子标题）
 * @param subDepth 子标题层级（通常为 3）
 * @param itemName 用于错误提示的项名
 * @param itemParser 单项解析函数（YAML + 子标题文本 → T）
 */
export function parseSubItemsByHeading<T>(
  parentSection: Section,
  subDepth: number,
  itemName: string,
  itemParser: (yaml: unknown, headingRaw: string) => T
): T[] {
  const results: T[] = [];
  let currentHeading: string | null = null;
  let currentChildren: import('./markdown-ast.js').MdastNode[] = [];

  const flush = () => {
    if (currentHeading === null) return;
    const codeBlock = findFirstCodeBlock(currentChildren, 'yaml');
    if (!codeBlock || !codeBlock.value) {
      throw new ParseError(
        `${itemName}声明"${currentHeading}"下缺少 YAML 代码块`,
        itemName
      );
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(codeBlock.value);
    } catch (err) {
      throw new ParseError(
        `${itemName}声明"${currentHeading}"的 YAML 解析失败：${err instanceof Error ? err.message : String(err)}`,
        itemName
      );
    }
    results.push(itemParser(parsed, currentHeading));
    currentHeading = null;
    currentChildren = [];
  };

  for (const node of parentSection.children) {
    if (node.type === 'heading' && (node as { depth: number }).depth === subDepth) {
      flush();
      currentHeading =
        node.children?.map((c) => c.value ?? '').join('') ?? '';
    } else if (currentHeading !== null) {
      currentChildren.push(node);
    }
  }
  flush();
  return results;
}

/**
 * 从三级标题文本中解析 "<id>: <name>" 或 "<id>" 格式。
 * 返回 { id, name }。
 */
export function parseIdNameHeading(headingRaw: string): { id: string; name: string } {
  const trimmed = headingRaw.trim();
  const match = trimmed.match(/^([^:：]+)[:：]\s*(.+)$/);
  if (match) {
    return { id: match[1].trim(), name: match[2].trim() };
  }
  return { id: trimmed, name: trimmed };
}
