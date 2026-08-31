/**
 * 组合层 composition.md 解析器
 *
 * 设计依据：《协议驱动自验证工具链设计方案》3.2.1 节 composition.md 格式、决策8
 *
 * 输入：protocol/composition.md（多协议系统的组合层 Markdown）
 * 输出：CompositionModel（组合层权威源，与各子协议 SourceProtocolModel 平行）
 *
 * composition.md 段落骨架（一级标题分节）：
 * - # 系统元数据        → metadata
 * - # 子协议清单         → subProtocols
 * - # 依赖图             → dependencyGraph（Mermaid + edges YAML）
 * - # 跨协议不变量       → crossInvariants（每条 ### 标题 + YAML）
 * - # 跨协议时序         → crossTiming
 * - # 外部依赖           → externalDependencies
 * - # 观测接口           → observationInterfaces
 * - # 对象状态切面       → objectStateFacets
 * - # 安全前提           → securityAssumptions
 *
 * 决策8：段落级可选 + 字段级必填。Mermaid 与 edges 共存时以 edges 为权威。
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type {
  CompositionModel,
  CompositionMetadata,
  SubProtocolRef,
  DependencyGraph,
  DependencyEdge,
  CrossInvariantDef,
  CrossTimingDef,
  ExternalDependencyDef,
  ObservationInterfaceDef,
  ObjectStateFacetDef,
  SecurityAssumptionDef,
  CrossProtocolComponentMapping,
  CrossProtocolComponentDef,
} from '../model/types.js';
import {
  parseMarkdownAst,
  splitByHeadings,
  findFirstCodeBlock,
  ParseError,
  type Section,
} from '../parser/markdown-ast.js';
import {
  findSectionByKeywords,
  parseSubItemsByHeading,
  parseIdNameHeading,
} from '../parser/extension-sections.js';

export { ParseError };

// ----------------------------------------------------------------------------
// 主入口
// ----------------------------------------------------------------------------

export function parseCompositionFile(filePath: string): CompositionModel {
  const content = readFileSync(filePath, 'utf-8');
  return parseCompositionContent(content, filePath);
}

export function parseCompositionContent(
  content: string,
  sourcePath?: string
): CompositionModel {
  const ast = parseMarkdownAst(content);
  const sections = splitByHeadings(ast);

  const metadata = parseCompositionMetadata(sections);
  const subProtocols = parseSubProtocols(sections);
  const dependencyGraph = parseDependencyGraph(sections);
  const crossInvariants = parseCrossInvariants(sections);
  const crossTiming = parseCrossTiming(sections);
  const externalDependencies = parseExternalDependencies(sections);
  const observationInterfaces = parseObservationInterfaces(sections);
  const objectStateFacets = parseObjectStateFacets(sections);
  const securityAssumptions = parseSecurityAssumptions(sections);
  // T5b：组合层「组件映射」段（跨协议组件归属，可选；老组合层无此段 → undefined，零回归）
  const crossProtocolComponents = parseCrossProtocolComponents(sections);

  return {
    metadata,
    subProtocols,
    dependencyGraph,
    crossInvariants,
    crossTiming,
    externalDependencies,
    observationInterfaces,
    objectStateFacets,
    securityAssumptions,
    crossProtocolComponents,
    sourcePath,
    parsedAt: new Date().toISOString(),
  };
}

// ----------------------------------------------------------------------------
// B1-I2 修复：宽松 YAML 解析（composition.md 段内含 `{...}: ...` / 多行 / 中英混排）
// ----------------------------------------------------------------------------
//
// 设计动机：composition.md 的"跨协议不变量/跨协议时序/外部依赖/观测接口/对象
// 状态切面/安全前提"等段的 YAML 含长 prose（如 expression=`forall op in {...}: ...`、
// checkMethod 多行含 `,` `:`），js-yaml 严格解析会抛错（"Nested mappings are not
// allowed in compact mappings" 等）。
//
// 解决：在 parseSubItemsByHeading 之前对 YAML 文本做"宽松化预处理"——识别已知的
// prose 字段（`expression` / `checkMethod` / `description` / `rule` /
// `assumption` / `impactIfViolated`），把它们转为 literal block scalar（`|`）形式
// 后再 parseYaml()。
//
// 边界：
// - 已声明的枚举字段（`complexity` / `dependencyType` / `direction` / `readOnly`）
//   严格 YAML 解析不动；如值非法仍由各 parser 校验抛错
// - 字段名白名单（PROSE_KEYS）只在本模块内增长；新增字段需在 PR review 显式列出

/** prose 字段名白名单（值允许含特殊字符；预处理为 literal block scalar） */
const PROSE_KEYS = new Set([
  'name',
  'expression',
  'checkMethod',
  'description',
  'rule',
  'assumption',
  'impactIfViolated',
  'queryObservationInterfaceId', // 可选字段，单行 prose
  'permissionBoundary',
  'syncSemantics',
]);

/**
 * 将 YAML 代码块文本中的 prose 字段值转为 literal block scalar（`|`）
 *
 * 算法（按行扫描）：
 * 1. 遇 `^(\s*)(<key>):\s*(.*)$` 且 key 在 PROSE_KEYS：
 *    - 若行尾有非空内容（单行值）：用单引号包裹
 *    - 若行尾为空：把后续缩进 ≥ key 缩进 + 2 的连续行收集为 block scalar，改写为 `|\n <lines>`
 * 2. 其它行原样保留
 *
 * 注：缩进保持与原 key 一致；block scalar 末尾换行由 yaml 包自动 trim。
 */
export function preprocessYamlProse(yamlText: string): string {
  const lines = yamlText.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m && PROSE_KEYS.has(m[2])) {
      const indent = m[1];
      const key = m[2];
      const inline = m[3];
      // B1-I2 修复：判定是否多行值——看紧接下一非空行是否比 key 缩进更深。
      // 若是，按 literal block scalar 处理（inline 作为首行 + 续行）；否则按单行值单引号包裹。
      let isMultiline = false;
      for (let j = i + 1; j < lines.length; j++) {
        const peek = lines[j];
        if (peek.trim() === '') continue; // 跳过空行
        // 缩进比较：peek 的前导空白数 > key 的前导空白数 → 多行值
        const peekIndent = peek.match(/^\s*/)?.[0].length ?? 0;
        if (peekIndent > indent.length) {
          isMultiline = true;
        }
        break;
      }
      if (isMultiline) {
        // 多行值：转为 literal block scalar
        const blockLines: string[] = inline ? [inline] : [];
        let j = i + 1;
        while (j < lines.length) {
          const child = lines[j];
          // 空行：属于 block 内容
          if (child.trim() === '') {
            blockLines.push('');
            j++;
            continue;
          }
          // 缩进 > key 缩进：属于本 key 的 block 内容
          const childIndentLen = child.match(/^\s*/)?.[0].length ?? 0;
          if (childIndentLen > indent.length) {
            // 去掉最小缩进（保留 child 内部相对缩进）
            blockLines.push(child.slice(indent.length + 2)); // 去掉 key 的缩进 + 2 个额外缩进（YAML block scalar 要求）
            j++;
            continue;
          }
          // 缩进 ≤ key 缩进且非空：遇到下一同级/上级 key，结束
          break;
        }
        // 输出 block scalar（YAML literal block：所有内容至少比 key 多 2 缩进）
        const blockBaseIndent = ' '.repeat(indent.length + 2);
        out.push(`${indent}${key}: |`);
        for (const b of blockLines) {
          if (b === '') {
            // 空行直接保留（YAML block scalar 内空行用缩进的换行表示）
            out.push(blockBaseIndent);
          } else {
            // 非空行：保留去除最小缩进后的内容 + 前置缩进
            out.push(blockBaseIndent + b);
          }
        }
        i = j;
      } else if (inline !== '') {
        // 单行值：单引号包裹
        out.push(`${indent}${key}: '${inline.replace(/'/g, "''")}'`);
        i++;
      } else {
        // 显式空值
        out.push(line);
        i++;
      }
    } else {
      out.push(line);
      i++;
    }
  }
  return out.join('\n');
}

// ----------------------------------------------------------------------------
// 段落定位辅助
// ----------------------------------------------------------------------------

/** 按关键词定位单个 section（必须存在则 required=true） */
function requireSection(sections: Section[], keywords: string[], name: string): Section {
  const s = findSectionByKeywords(sections, keywords);
  if (!s) {
    throw new ParseError(`composition.md 缺少必要段落"${name}"`, name);
  }
  return s;
}

function optionalSection(
  sections: Section[],
  keywords: string[]
): Section | null {
  return findSectionByKeywords(sections, keywords);
}

// ----------------------------------------------------------------------------
// 系统元数据
// ----------------------------------------------------------------------------

function parseCompositionMetadata(sections: Section[]): CompositionMetadata {
  const section = requireSection(sections, ['系统元数据', 'metadata', '元数据'], '系统元数据');
  const code = findFirstCodeBlock(section.children, 'yaml');
  if (!code || !code.value) {
    throw new ParseError('系统元数据段下缺少 YAML 代码块', '系统元数据');
  }
  let raw: Record<string, unknown>;
  try {
    raw = parseYaml(code.value) as Record<string, unknown>;
  } catch (err) {
    throw new ParseError(
      `系统元数据 YAML 解析失败：${err instanceof Error ? err.message : String(err)}`,
      '系统元数据'
    );
  }
  const changeType = raw.changeType as string | undefined;
  // B1-I2 修复：changeType 枚举扩展接受 protocol_extend（hsk-ng 迭代 17 引入）
  if (
    changeType !== 'protocol_tweak' &&
    changeType !== 'paradigm_renegotiation' &&
    changeType !== 'protocol_extend'
  ) {
    throw new ParseError(
      `系统元数据 changeType 必须是 protocol_tweak / paradigm_renegotiation / protocol_extend，实际为 ${changeType}`,
      '系统元数据'
    );
  }
  return {
    systemName: requireString(raw, 'systemName', '系统元数据'),
    version: requireString(raw, 'version', '系统元数据'),
    changeType,
    previousVersion: optionalString(raw, 'previousVersion'),
  };
}

// ----------------------------------------------------------------------------
// 子协议清单
// ----------------------------------------------------------------------------

function parseSubProtocols(sections: Section[]): SubProtocolRef[] {
  const section = requireSection(sections, ['子协议清单', '子协议', 'subprotocol'], '子协议清单');
  const code = findFirstCodeBlock(section.children, 'yaml');
  if (!code || !code.value) {
    throw new ParseError('子协议清单段下缺少 YAML 代码块', '子协议清单');
  }
  let arr: unknown;
  try {
    arr = parseYaml(code.value);
  } catch (err) {
    throw new ParseError(
      `子协议清单 YAML 解析失败：${err instanceof Error ? err.message : String(err)}`,
      '子协议清单'
    );
  }
  if (!Array.isArray(arr)) {
    throw new ParseError('子协议清单 YAML 必须是数组', '子协议清单');
  }
  return arr.map((item, idx) => {
    const r = asRecord(item, `子协议清单[${idx}]`);
    return {
      protocolId: requireString(r, 'protocolId', `子协议清单[${idx}]`),
      name: requireString(r, 'name', `子协议清单[${idx}]`),
      version: requireString(r, 'version', `子协议清单[${idx}]`),
      modelPath: requireString(r, 'modelPath', `子协议清单[${idx}]`),
    };
  });
}

// ----------------------------------------------------------------------------
// 依赖图（Mermaid + edges YAML，edges 为权威）
// ----------------------------------------------------------------------------

function parseDependencyGraph(sections: Section[]): DependencyGraph {
  const section = requireSection(sections, ['依赖图', 'dependencygraph'], '依赖图');

  // Mermaid 代码块（人读）
  const mermaidBlock = findFirstCodeBlock(section.children, 'mermaid');
  const mermaid = mermaidBlock?.value ?? '';

  // edges YAML（工具消费，权威）
  const edgesBlock = findFirstCodeBlock(section.children, 'yaml');
  let edges: DependencyEdge[] = [];
  if (edgesBlock && edgesBlock.value) {
    let arr: unknown;
    try {
      arr = parseYaml(edgesBlock.value);
    } catch (err) {
      throw new ParseError(
        `依赖图 edges YAML 解析失败：${err instanceof Error ? err.message : String(err)}`,
        '依赖图'
      );
    }
    if (!Array.isArray(arr)) {
      throw new ParseError('依赖图 edges YAML 必须是数组', '依赖图');
    }
    edges = arr.map((item, idx) => {
      const r = asRecord(item, `依赖图.edges[${idx}]`);
      const dt = r.dependencyType as string | undefined;
      if (dt !== 'state' && dt !== 'event') {
        throw new ParseError(
          `依赖图.edges[${idx}].dependencyType 必须是 state 或 event，实际为 ${dt}`,
          '依赖图'
        );
      }
      return {
        from: requireString(r, 'from', `依赖图.edges[${idx}]`),
        to: requireString(r, 'to', `依赖图.edges[${idx}]`),
        dependencyType: dt,
        description: requireString(r, 'description', `依赖图.edges[${idx}]`),
      };
    });
  }

  // 校验：Mermaid 与 edges 至少存在其一
  if (mermaid === '' && edges.length === 0) {
    throw new ParseError(
      '依赖图段缺少 Mermaid 代码块与 edges YAML（至少存在其一）',
      '依赖图'
    );
  }

  return { mermaid, edges };
}

// ----------------------------------------------------------------------------
// 跨协议不变量（每条 ### 标题 + YAML）
// ----------------------------------------------------------------------------

function parseCrossInvariants(sections: Section[]): CrossInvariantDef[] {
  const section = optionalSection(sections, ['跨协议不变量', 'crossinvariant']);
  if (!section) return [];
  return parseSubItemsByHeading(
    section,
    3,
    '跨协议不变量',
    (yaml, headingRaw) => {
      const r = asRecord(yaml, '跨协议不变量');
      const { id } = parseIdNameHeading(headingRaw);
      const complexity = r.complexity as string | undefined;
      if (complexity !== 'simple_boolean' && complexity !== 'first_order') {
        throw new ParseError(
          `跨协议不变量"${id}"的 complexity 必须是 simple_boolean 或 first_order`,
          '跨协议不变量'
        );
      }
      return {
        id: requireString(r, 'id', '跨协议不变量'),
        name: requireString(r, 'name', '跨协议不变量'),
        span: asStringArray(r.span, `跨协议不变量.${id}.span`),
        expression: requireString(r, 'expression', '跨协议不变量'),
        declaredBy: requireString(r, 'declaredBy', '跨协议不变量'),
        checkMethod: requireString(r, 'checkMethod', '跨协议不变量'),
        complexity,
      };
    },
    // B1-I2 修复：跨协议不变量含 expression/checkMethod prose 字段
    preprocessYamlProse
  );
}

// ----------------------------------------------------------------------------
// 跨协议时序
// ----------------------------------------------------------------------------

function parseCrossTiming(sections: Section[]): CrossTimingDef[] {
  const section = optionalSection(sections, ['跨协议时序', 'crosstiming']);
  if (!section) return [];
  return parseSubItemsByHeading(
    section,
    3,
    '跨协议时序',
    (yaml, headingRaw) => {
      const r = asRecord(yaml, '跨协议时序');
      const { id } = parseIdNameHeading(headingRaw);
      const boundMs = r.boundMs as number | undefined;
      return {
        id: requireString(r, 'id', '跨协议时序'),
        name: requireString(r, 'name', '跨协议时序'),
        rule: requireString(r, 'rule', '跨协议时序'),
        span: asStringArray(r.span, `跨协议时序.${id}.span`),
        boundMs: typeof boundMs === 'number' ? boundMs : undefined,
      };
    },
    // B1-I2 修复：跨协议时序含 rule prose
    preprocessYamlProse
  );
}

// ----------------------------------------------------------------------------
// 外部依赖
// ----------------------------------------------------------------------------

function parseExternalDependencies(sections: Section[]): ExternalDependencyDef[] {
  const section = optionalSection(sections, ['外部依赖', 'externaldependency']);
  if (!section) return [];
  return parseSubItemsByHeading(
    section,
    3,
    '外部依赖',
    (yaml, headingRaw) => {
      const r = asRecord(yaml, '外部依赖');
      const { id: _id, name: _name } = parseIdNameHeading(headingRaw);
      const direction = r.direction as string | undefined;
      if (direction !== 'event_sync' && direction !== 'login_receipt' && direction !== 'query') {
        throw new ParseError(
          `外部依赖的 direction 必须是 event_sync / login_receipt / query，实际为 ${direction}`,
          '外部依赖'
        );
      }
      const result: ExternalDependencyDef = {
        system: requireString(r, 'system', '外部依赖'),
        direction,
        protocol: requireString(r, 'protocol', '外部依赖'),
        syncSemantics: requireString(r, 'syncSemantics', '外部依赖'),
        syncCharacteristics: asStringArray(r.syncCharacteristics, '外部依赖.syncCharacteristics'),
        compensation: asStringArray(r.compensation, '外部依赖.compensation'),
        impactOnFailure: requireString(r, 'impactOnFailure', '外部依赖'),
      };
      const qoi = optionalString(r, 'queryObservationInterfaceId');
      if (qoi) result.queryObservationInterfaceId = qoi;
      return result;
    },
    // B1-I2 修复：外部依赖含 syncSemantics/impactOnFailure prose
    preprocessYamlProse
  );
}

// ----------------------------------------------------------------------------
// 观测接口
// ----------------------------------------------------------------------------

function parseObservationInterfaces(sections: Section[]): ObservationInterfaceDef[] {
  const section = optionalSection(sections, ['观测接口', 'observationinterface']);
  if (!section) return [];
  return parseSubItemsByHeading(
    section,
    3,
    '观测接口',
    (yaml, headingRaw) => {
      const r = asRecord(yaml, '观测接口');
      const { id } = parseIdNameHeading(headingRaw);
      const observableRaw = r.observable;
      if (!Array.isArray(observableRaw)) {
        throw new ParseError(`观测接口"${id}"的 observable 必须是数组`, '观测接口');
      }
      const observable = observableRaw.map((item, idx) => {
        const o = asRecord(item, `观测接口.${id}.observable[${idx}]`);
        return {
          protocol: requireString(o, 'protocol', `观测接口.${id}.observable[${idx}]`),
          object: requireString(o, 'object', `观测接口.${id}.observable[${idx}]`),
          fields: asStringArray(o.fields, `观测接口.${id}.observable[${idx}].fields`),
          filter: optionalString(o, 'filter'),
        };
      });
      return {
        id: requireString(r, 'id', '观测接口'),
        name: requireString(r, 'name', '观测接口'),
        observer: requireString(r, 'observer', '观测接口'),
        scope: requireString(r, 'scope', '观测接口'),
        permissionBoundary: requireString(r, 'permissionBoundary', '观测接口'),
        readOnly: true as const,
        observable,
      };
    },
    // B1-I2 修复：观测接口含 scope/permissionBoundary prose
    preprocessYamlProse
  );
}

// ----------------------------------------------------------------------------
// 对象状态切面
// ----------------------------------------------------------------------------

function parseObjectStateFacets(sections: Section[]): ObjectStateFacetDef[] {
  const section = optionalSection(sections, ['对象状态切面', 'objectstatefacet']);
  if (!section) return [];
  return parseSubItemsByHeading(
    section,
    3,
    '对象状态切面',
    (yaml, headingRaw) => {
      const r = asRecord(yaml, '对象状态切面');
      const { id: _id, name: objectName } = parseIdNameHeading(headingRaw);
      const facetsRaw = r.facets;
      if (!Array.isArray(facetsRaw)) {
        throw new ParseError(`对象状态切面"${objectName}"的 facets 必须是数组`, '对象状态切面');
      }
      const facets = facetsRaw.map((item, idx) => {
        const f = asRecord(item, `对象状态切面.${objectName}.facets[${idx}]`);
        return {
          protocol: requireString(f, 'protocol', `对象状态切面.${objectName}.facets[${idx}]`),
          dimensions: asStringArray(f.dimensions, `对象状态切面.${objectName}.facets[${idx}].dimensions`),
          description: requireString(f, 'description', `对象状态切面.${objectName}.facets[${idx}]`),
        };
      });
      const constraintsRaw = r.crossFacetConstraints;
      if (!Array.isArray(constraintsRaw)) {
        throw new ParseError(`对象状态切面"${objectName}"的 crossFacetConstraints 必须是数组`, '对象状态切面');
      }
      const crossFacetConstraints = constraintsRaw.map((item, idx) => {
        const c = asRecord(item, `对象状态切面.${objectName}.crossFacetConstraints[${idx}]`);
        return {
          expression: requireString(c, 'expression', `对象状态切面.${objectName}.crossFacetConstraints[${idx}]`),
          tracesToInvariantId: requireString(c, 'tracesToInvariantId', `对象状态切面.${objectName}.crossFacetConstraints[${idx}]`),
        };
      });
      return {
        object: requireString(r, 'object', '对象状态切面'),
        idKey: requireString(r, 'idKey', '对象状态切面'),
        facets,
        crossFacetConstraints,
      };
    },
    // B1-I2 修复：对象状态切面含 description/expression prose（嵌套）
    preprocessYamlProse
  );
}

// ----------------------------------------------------------------------------
// 安全前提
// ----------------------------------------------------------------------------

function parseSecurityAssumptions(sections: Section[]): SecurityAssumptionDef[] {
  const section = optionalSection(sections, ['安全前提', 'securityassumption']);
  if (!section) return [];
  return parseSubItemsByHeading(
    section,
    3,
    '安全前提',
    (yaml, headingRaw) => {
      const r = asRecord(yaml, '安全前提');
      const { id } = parseIdNameHeading(headingRaw);
      return {
        id: requireString(r, 'id', '安全前提'),
        assumption: requireString(r, 'assumption', `安全前提.${id}`),
        description: requireString(r, 'description', `安全前提.${id}`),
        impactIfViolated: requireString(r, 'impactIfViolated', `安全前提.${id}`),
      };
    },
    // B1-I2 修复：安全前提含 assumption/description/impactIfViolated prose
    preprocessYamlProse
  );
}

// ----------------------------------------------------------------------------
// 工具函数
// ----------------------------------------------------------------------------

function requireString(
  obj: Record<string, unknown>,
  key: string,
  section: string
): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new ParseError(`${section} 缺少必填字段 "${key}" 或字段非字符串`);
  }
  return v.trim();
}

/**
 * T5b：组合层「组件映射」段（跨协议组件归属，可选段）。
 * YAML 形态（与 T1a 组件模型同构 + protocolId）：
 *   components: [{ name, description?, baseUrl?, auth? }]
 *   interfaceImplementations: [{ interface, protocolId, component, description? }]
 * 段不存在 → undefined（老组合层零回归）；声明存在但缺 YAML → ParseError。
 */
function parseCrossProtocolComponents(
  sections: Section[]
): CrossProtocolComponentMapping | undefined {
  const section = findSectionByKeywords(sections, ['组件映射', 'componentmapping']);
  if (!section) return undefined;
  const codeBlock = findFirstCodeBlock(section.children, 'yaml');
  if (!codeBlock || !codeBlock.value) {
    throw new ParseError('组合层「组件映射」段声明存在，但其下缺少 YAML 代码块', '组件映射');
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(codeBlock.value);
  } catch (err) {
    throw new ParseError(
      `组合层「组件映射」段 YAML 解析失败：${err instanceof Error ? err.message : String(err)}`,
      '组件映射'
    );
  }
  const r = asRecord(parsed, '组件映射');
  const components = Array.isArray(r.components)
    ? (r.components as unknown[]).map((item, idx) => {
        const o = asRecord(item, `组件映射.components[${idx}]`);
        const def: CrossProtocolComponentDef = {
          name: requireString(o, 'name', `组件映射.components[${idx}]`),
        };
        const description = optionalString(o, 'description');
        if (description !== undefined) def.description = description;
        const baseUrl = optionalString(o, 'baseUrl');
        if (baseUrl !== undefined) def.baseUrl = baseUrl;
        const auth = optionalString(o, 'auth');
        if (auth !== undefined) {
          if (!['none', 'bearer', 'oauth', 'api-key'].includes(auth)) {
            throw new ParseError(
              `组件映射.components[${idx}].auth 必须是 none | bearer | oauth | api-key，实际为 ${auth}`,
              '组件映射'
            );
          }
          def.auth = auth as 'none' | 'bearer' | 'oauth' | 'api-key';
        }
        return def;
      })
    : undefined;
  const interfaceImplementations = Array.isArray(r.interfaceImplementations)
    ? (r.interfaceImplementations as unknown[]).map((item, idx) => {
        const o = asRecord(item, `组件映射.interfaceImplementations[${idx}]`);
        const m = {
          interface: requireString(o, 'interface', `组件映射.interfaceImplementations[${idx}]`),
          protocolId: requireString(o, 'protocolId', `组件映射.interfaceImplementations[${idx}]`),
          component: requireString(o, 'component', `组件映射.interfaceImplementations[${idx}]`),
        };
        const description = optionalString(o, 'description');
        if (description !== undefined) (m as { description?: string }).description = description;
        return m;
      })
    : undefined;
  return { components: components ?? [], interfaceImplementations: interfaceImplementations ?? [] };
}

function optionalString(
  obj: Record<string, unknown>,
  key: string
): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

function asRecord(yaml: unknown, section: string): Record<string, unknown> {
  if (!yaml || typeof yaml !== 'object' || Array.isArray(yaml)) {
    throw new ParseError(`${section} 的 YAML 必须是对象`);
  }
  return yaml as Record<string, unknown>;
}

function asStringArray(yaml: unknown, fieldPath: string): string[] {
  if (yaml === undefined || yaml === null) return [];
  if (!Array.isArray(yaml)) {
    throw new ParseError(`${fieldPath} 必须是字符串数组`);
  }
  return yaml.map((item, idx) => {
    if (typeof item !== 'string') {
      throw new ParseError(`${fieldPath}[${idx}] 必须是字符串`);
    }
    return item;
  });
}
