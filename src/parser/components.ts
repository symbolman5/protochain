/**
 * T1a（§1.4 定案）：组件模型 components.md 解析器
 *
 * 输入：<协议根>/components.md（单协议组件模型独立文档，与 model.md 同级）
 * 输出：ComponentModel（组件定义 + 三张映射表 + 接口契约）
 *
 * 段落骨架（一级标题分节，YAML 代码块承载结构化数据，与 composition.md 风格一致）：
 * - # 组件定义    → components[]：name / description(职责) / baseUrl / auth(none|bearer|oauth|api-key)
 * - # 组件映射    → interfaceImplementations / dimensionStorage / componentTransfers（三张映射表，
 *                   与 model.md 内嵌组件映射段同构，parser 复用 parseComponentMapping 语义）
 * - # 接口契约    → contracts[]：interface → { path, method, authorization(凭证引用或鉴权类型),
 *                   requestSchema / responseSchema / errorResponses（引用协议层契约，可选）}
 *
 * front matter（宽松）：name / protocolId 可选（不要求 version/purpose，避免与协议元数据耦合）。
 * 决策8：段落级可选 + 字段级必填；段声明存在但缺 YAML 代码块 → ParseError。
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type {
  ComponentModel,
  ComponentMappingDef,
  ComponentDef,
  ComponentContractDef,
} from '../model/types.js';
import {
  parseMarkdownAst,
  splitByHeadings,
  findFirstCodeBlock,
  ParseError,
  type Section,
} from './markdown-ast.js';
import {
  findSectionByKeywords,
  detectExtensionSection,
} from './extension-sections.js';
import {
  requireString,
  optionalString,
  asRecord,
  asStringArray,
  asRecordArray,
  parseComponentMapping,
} from './index.js';

export { ParseError };

// ----------------------------------------------------------------------------
// 主入口
// ----------------------------------------------------------------------------

export function parseComponentsFile(filePath: string): ComponentModel {
  const content = readFileSync(filePath, 'utf-8');
  return parseComponentsContent(content, filePath);
}

export function parseComponentsContent(
  content: string,
  sourcePath?: string
): ComponentModel {
  const { frontMatter, body } = splitFrontMatter(content);
  const meta = parseComponentFrontMatter(frontMatter);
  const ast = parseMarkdownAst(body);
  const sections = splitByHeadings(ast);

  const components = parseComponentDefs(sections);
  // 三张映射表（与 model.md 内嵌组件映射段同构；段不存在 → 空三表）
  const mapping: ComponentMappingDef =
    parseComponentMapping(sections) ??
    { interfaceImplementations: [], dimensionStorage: [], componentTransfers: [] };
  const contracts = parseContracts(sections);

  return {
    name: meta.name,
    protocolId: meta.protocolId,
    components,
    contracts,
    mapping,
    sourcePath,
  };
}

// ----------------------------------------------------------------------------
// Front Matter（宽松）
// ----------------------------------------------------------------------------

interface ComponentFrontMatter {
  name?: string;
  protocolId?: string;
}

function splitFrontMatter(content: string): { frontMatter: string | null; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontMatter: null, body: content };
  }
  return { frontMatter: match[1], body: match[2] };
}

function parseComponentFrontMatter(frontMatter: string | null): ComponentFrontMatter {
  if (!frontMatter) return {};
  let raw: unknown;
  try {
    raw = parseYaml(frontMatter);
  } catch (err) {
    throw new ParseError(
      `components.md front matter 解析失败：${err instanceof Error ? err.message : String(err)}`,
      '组件模型'
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ParseError('components.md front matter 必须是 YAML 对象', '组件模型');
  }
  const r = raw as Record<string, unknown>;
  return {
    name: optionalString(r, 'name'),
    protocolId: optionalString(r, 'protocolId'),
  };
}

// ----------------------------------------------------------------------------
// 组件定义（## 组件定义 → components[]）
// ----------------------------------------------------------------------------

const AUTH_TYPES = ['none', 'bearer', 'oauth', 'api-key'] as const;

function parseComponentDefs(sections: Section[]): ComponentDef[] | undefined {
  const detection = detectExtensionSection(
    sections,
    ['组件定义', 'componentdefinition', 'componentdefs'],
    '组件定义'
  );
  if (!detection.enabled) return undefined;
  const r = asRecord(detection.yaml, '组件定义');
  return asRecordArray(r.components, '组件定义.components').map((item, idx) => {
    const path = `组件定义.components[${idx}]`;
    const def: ComponentDef = {
      name: requireString(item, 'name', path),
    };
    const description = optionalString(item, 'description');
    if (description !== undefined) def.description = description;
    const baseUrl = optionalString(item, 'baseUrl');
    if (baseUrl !== undefined) def.baseUrl = baseUrl;
    const auth = optionalString(item, 'auth');
    if (auth !== undefined) {
      if (!(AUTH_TYPES as readonly string[]).includes(auth)) {
        throw new ParseError(
          `${path}.auth 必须是 ${AUTH_TYPES.join(' | ')}，实际为 ${auth}`,
          '组件定义'
        );
      }
      def.auth = auth as ComponentDef['auth'];
    }
    return def;
  });
}

// ----------------------------------------------------------------------------
// 接口契约（## 接口契约 → contracts[]）
// ----------------------------------------------------------------------------

const CONTRACT_AUTH_TYPES = ['none', 'bearer', 'oauth', 'api-key'] as const;

function parseContracts(sections: Section[]): ComponentContractDef[] | undefined {
  const detection = detectExtensionSection(
    sections,
    ['接口契约', 'interfacecontract', 'contracts'],
    '接口契约'
  );
  if (!detection.enabled) return undefined;
  const r = asRecord(detection.yaml, '接口契约');
  return asRecordArray(r.contracts, '接口契约.contracts').map((item, idx) => {
    const path = `接口契约.contracts[${idx}]`;
    const contract: ComponentContractDef = {
      interface: requireString(item, 'interface', path),
    };
    const method = optionalString(item, 'method');
    if (method !== undefined) contract.method = method.toUpperCase();
    const p = optionalString(item, 'path');
    if (p !== undefined) contract.path = p;
    const authorization = optionalString(item, 'authorization');
    if (authorization !== undefined) {
      const lower = authorization.toLowerCase();
      if ((CONTRACT_AUTH_TYPES as readonly string[]).includes(lower) && authorization === lower) {
        // 鉴权类型枚举（全小写命中，如 none/bearer/oauth/api-key）
        contract.authorization = lower;
      } else {
        // 凭证引用（credentials 段凭证名；checker 校验存在性）
        contract.authorization = authorization;
      }
    }
    const requestSchema = optionalString(item, 'requestSchema');
    if (requestSchema !== undefined) contract.requestSchema = requestSchema;
    const responseSchema = optionalString(item, 'responseSchema');
    if (responseSchema !== undefined) contract.responseSchema = responseSchema;
    const errorResponses = asStringArray(item.errorResponses, `${path}.errorResponses`);
    if (errorResponses.length > 0) contract.errorResponses = errorResponses;
    return contract;
  });
}
