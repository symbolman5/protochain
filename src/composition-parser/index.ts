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
    sourcePath,
    parsedAt: new Date().toISOString(),
  };
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
  if (changeType !== 'protocol_tweak' && changeType !== 'paradigm_renegotiation') {
    throw new ParseError(
      `系统元数据 changeType 必须是 protocol_tweak 或 paradigm_renegotiation，实际为 ${changeType}`,
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
    }
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
    }
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
    }
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
    }
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
    }
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
    }
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
