/**
 * 轻量 Markdown AST 基础设施（parser 与 composition-parser 共用）
 *
 * 设计依据：《协议驱动自验证工具链设计方案》2.1 节扩展段检测规则、决策8 段落级可选
 *
 * 仅解析工具链所需的结构：heading / table / code / list / paragraph。
 * 不依赖外部 AST 库（unified/remark 纯 ESM 与 jest 兼容性差），自实现轻量解析。
 */

// ----------------------------------------------------------------------------
// AST 节点类型
// ----------------------------------------------------------------------------

export interface MdastNode {
  type: string;
  value?: string;
  lang?: string;
  children?: MdastNode[];
  depth?: number;
  ordered?: boolean;
  align?: ('left' | 'right' | 'center' | null)[];
}

export interface Heading extends MdastNode {
  type: 'heading';
  depth: number;
}

export interface Table extends MdastNode {
  type: 'table';
  align?: ('left' | 'right' | 'center' | null)[];
}

export interface Code extends MdastNode {
  type: 'code';
  lang: string;
}

export interface Paragraph extends MdastNode {
  type: 'paragraph';
}

export interface ListItem extends MdastNode {
  type: 'listItem';
}

// ----------------------------------------------------------------------------
// 解析错误
// ----------------------------------------------------------------------------

export class ParseError extends Error {
  constructor(
    message: string,
    public readonly section?: string,
    public readonly line?: number
  ) {
    super(message);
    this.name = 'ParseError';
  }
}

// ----------------------------------------------------------------------------
// 轻量 Markdown 解析
// ----------------------------------------------------------------------------

/**
 * 仅解析工具链所需的结构：
 * - heading：# / ## / ### 等开头
 * - table：| 分隔的表格（含表头分隔行）
 * - code：``` 包裹的代码块（含 lang）
 * - list：- 或 * 开头的列表项
 * - paragraph：其余连续非空行
 */
export function parseMarkdownAst(markdown: string): MdastNode {
  return parseMarkdownLightweight(markdown);
}

function parseMarkdownLightweight(markdown: string): MdastNode {
  const lines = markdown.split(/\r?\n/);
  const root: MdastNode = { type: 'root', children: [] };
  const children = root.children!;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (line.trim() === '') {
      i++;
      continue;
    }

    // 代码块
    if (line.trim().startsWith('```')) {
      const lang = line.trim().replace(/^```/, '').trim();
      const valueLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        valueLines.push(lines[i]);
        i++;
      }
      i++; // 跳过结束的 ```
      children.push({ type: 'code', lang: lang || '', value: valueLines.join('\n') });
      continue;
    }

    // 标题
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const depth = headingMatch[1].length;
      const text = headingMatch[2].trim();
      children.push({
        type: 'heading',
        depth,
        children: [{ type: 'text', value: text }],
      });
      i++;
      continue;
    }

    // 表格（当前行包含 | 且下一行是分隔行 |---|）
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|/.test(lines[i + 1])) {
      const tableRows: string[][] = [];
      // 表头
      tableRows.push(parseTableRow(line));
      i++; // 跳过表头
      i++; // 跳过分隔行
      // 表体
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        tableRows.push(parseTableRow(lines[i]));
        i++;
      }
      children.push(buildTableNode(tableRows));
      continue;
    }

    // 列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: MdastNode[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const text = lines[i].replace(/^\s*[-*+]\s+/, '').trim();
        items.push({
          type: 'listItem',
          children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
        });
        i++;
      }
      children.push({ type: 'list', ordered: false, children: items });
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: MdastNode[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const text = lines[i].replace(/^\s*\d+\.\s+/, '').trim();
        items.push({
          type: 'listItem',
          children: [{ type: 'paragraph', children: [{ type: 'text', value: text }] }],
        });
        i++;
      }
      children.push({ type: 'list', ordered: true, children: items });
      continue;
    }

    // 段落（连续非空行）
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trim().startsWith('```') &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !(lines[i].includes('|') && i + 1 < lines.length && /^\s*\|?[\s:-]+\|/.test(lines[i + 1]))
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      const text = paraLines.join('\n').trim();
      children.push({
        type: 'paragraph',
        children: parseInlineText(text),
      });
    }
  }

  return root;
}

function parseTableRow(line: string): string[] {
  // 去除首尾的 |，按 | 分割
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

function buildTableNode(rows: string[][]): MdastNode {
  if (rows.length === 0) return { type: 'table', children: [] };
  const children: MdastNode[] = rows.map((row) => ({
    type: 'tableRow',
    children: row.map((cell) => ({
      type: 'tableCell',
      children: parseInlineText(cell),
    })),
  }));
  return { type: 'table', children };
}

/**
 * 解析行内文本：识别 **bold**、`code`、[link](url) 等格式
 * 简化实现：保留纯文本，剥离格式标记
 */
function parseInlineText(text: string): MdastNode[] {
  const cleaned = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  return [{ type: 'text', value: cleaned }];
}

// ----------------------------------------------------------------------------
// Section 切分
// ----------------------------------------------------------------------------

export interface Section {
  /** 标题文本（小写，去空白） */
  heading: string;
  /** 标题原始文本 */
  headingRaw: string;
  /** 标题层级 */
  depth: number;
  /** 该标题下的内容节点 */
  children: MdastNode[];
}

/**
 * 按一级标题切分 section（协议 model.md 主分节）。
 *
 * 协议模型格式契约：正文小节一律使用一级标题（# 状态空间 / # 转移规则 / ...）。
 * 新增内容应"完整修改协议"（并入既有小节），而非另起 H2 追加小节——
 * H2 会并入上一 H1 小节，造成内容静默丢失或误判（见修改单 001 关联分析）。
 * composition.md 的 H3 条目（如 ### CI1）依赖本函数保留在父 H1 小节内。
 * 顶级节点不在任何标题下时忽略。
 */
export function splitByHeadings(root: MdastNode): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const node of root.children ?? []) {
    if (node.type === 'heading' && (node as Heading).depth === 1) {
      if (current) sections.push(current);
      const headingRaw = node.children?.map((c) => c.value ?? '').join('') ?? '';
      current = {
        heading: normalizeHeading(headingRaw),
        headingRaw,
        depth: (node as Heading).depth,
        children: [],
      };
    } else if (current) {
      current.children.push(node);
    }
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * 按指定层级切分 section（composition.md 用二级/三级标题分节）。
 * 返回所有 depth 等于 targetDepth 的标题及其后续内容（直到下一个同级或更高级标题）。
 */
export function splitByDepth(root: MdastNode, targetDepth: number): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const node of root.children ?? []) {
    if (node.type === 'heading' && (node as Heading).depth === targetDepth) {
      if (current) sections.push(current);
      const headingRaw = node.children?.map((c) => c.value ?? '').join('') ?? '';
      current = {
        heading: normalizeHeading(headingRaw),
        headingRaw,
        depth: (node as Heading).depth,
        children: [],
      };
    } else if (
      node.type === 'heading' &&
      (node as Heading).depth < targetDepth &&
      current
    ) {
      // 遇到更高级标题，结束当前 section
      sections.push(current);
      current = null;
    } else if (current) {
      current.children.push(node);
    }
  }
  if (current) sections.push(current);
  return sections;
}

export function normalizeHeading(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '');
}

// ----------------------------------------------------------------------------
// 节点工具
// ----------------------------------------------------------------------------

export function nodeToText(node: MdastNode): string {
  if (node.value !== undefined) return node.value;
  if (!node.children) return '';
  return node.children.map((c) => nodeToText(c)).join('');
}

/** 在节点列表中查找首个表格 */
export function findFirstTable(nodes: MdastNode[]): Table | null {
  for (const node of nodes) {
    if (node.type === 'table') return node as Table;
  }
  return null;
}

/** 在节点列表中查找首个指定语言的代码块；lang 为空则匹配任意代码块 */
export function findFirstCodeBlock(nodes: MdastNode[], lang?: string): Code | null {
  for (const node of nodes) {
    if (node.type === 'code') {
      const code = node as Code;
      if (!lang || code.lang.toLowerCase() === lang.toLowerCase()) {
        return code;
      }
    }
  }
  return null;
}

/** 表格转对象数组（表头行 + 数据行） */
export function tableToObjects(
  table: Table,
  headerNormalizer?: (header: string) => string
): Record<string, string>[] {
  const rows = (table.children ?? []).filter((r) => r.type === 'tableRow');
  if (rows.length < 2) return [];

  const headerCells = rows[0].children ?? [];
  const headers = headerCells.map((c) => {
    const h = nodeToText(c).trim();
    return headerNormalizer ? headerNormalizer(h) : h;
  });

  const objects: Record<string, string>[] = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i].children ?? [];
    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      const value = j < cells.length ? nodeToText(cells[j]).trim() : '';
      obj[headers[j]] = value;
    }
    objects.push(obj);
  }
  return objects;
}
