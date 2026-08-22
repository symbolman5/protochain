#!/usr/bin/env node
/**
 * protochain CLI 入口
 *
 * 设计依据：《协议驱动自验证工具链设计方案》第六节 CLI命令
 *
 * P1-P4 已实现（完整十步流程 + 迭代支撑）：
 *   protochain init --name <协议名>
 *   protochain check            （① 完备性检查）
 *   protochain reason           （② AI 推演）
 *   protochain formalize        （③ 形式化验证）
 *   protochain derive-specs     （⑤ 规格推导）
 *   protochain derive-contracts （④ 契约推导）
 *   protochain generate-tests   （⑥ 测试工具生成）
 *   protochain generate-cases   （⑦ 测试用例生成）
 *   protochain generate-scaffold（⑨ 接口骨架生成）
 *   protochain check-impl       （⑧ 实现完整性检查）
 *   protochain verify           （⑩ 一致性验证）
 *   protochain run [--from <步骤>] [--to <步骤>]
 *   protochain status
 *   protochain diff             （差分引擎）
 *   protochain impact           （影响分析）
 *   protochain propagate        （变更传播）
 *   protochain version save|list|show|classify（版本管理）
 *   protochain config set <key> <value>
 *   protochain config get <key>
 */

import { Command } from 'commander';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { resolve, join, dirname, isAbsolute as pathIsAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { parse as parseYaml } from 'yaml';
import { initProject, initMultiProject, initRunnerProject } from '../scaffolder/index.js';
import { executeTask, type ExecTaskInput } from '../exec-task/index.js';
import { parseProtocolFile } from '../parser/index.js';
import { parseCompositionFile } from '../composition-parser/index.js';
import { checkCompleteness } from '../checker/index.js';
import { checkCompositionCompleteness, type PendingRefWithSource } from '../composition-checker/index.js';
import { checkSemanticCompleteness } from '../checker-ai/index.js';
import { checkCompositionSemantic } from '../composition-checker-ai/index.js';
import { checkCrossInvariants } from '../cross-invariant-checker/index.js';
import { crossFormalize } from '../cross-formalizer/index.js';
import { deriveCrossContracts } from '../cross-contractor/index.js';
import { generateCrossCases } from '../cross-casegen/index.js';
import { createAIRouter } from '../ai/router.js';
import {
  registerExecutor,
  runPipeline,
  presentCheckpoint,
  loadState,
  buildStatusView,
  formatStatusView,
  getExecutor,
  recordManifest,
  type CheckpointDecision,
} from '../orchestrator/index.js';
import { createCheckExecutor } from '../steps/check.js';
import { createReasonExecutor } from '../steps/reason.js';
import { createFormalizeExecutor } from '../steps/formalize.js';
import { createSpecifyExecutor } from '../steps/specify.js';
import { createContractExecutor } from '../steps/contract.js';
import { createTestGenExecutor } from '../steps/testgen.js';
import { createCaseGenExecutor } from '../steps/casegen.js';
import { createImplCheckExecutor } from '../steps/implcheck.js';
import { createVerifyExecutor } from '../steps/verify.js';
import { loadConfig, saveConfig, setConfigValue } from './config.js';
import {
  resolveProjectContext,
  type ProjectContext,
  type ContextRole,
} from '../project/context.js';
import { scaffoldInterfaces } from '../scaffolder/index.js';
import { checkImplementation, formatImplCheckSummary } from '../implcheck/index.js';
import { verify, formatVerificationSummary, type ProtocolImplementationStub } from '../verifier/index.js';
import { diffModels, formatDiffSummary } from '../differ/index.js';
import {
  classifyChange,
  formatClassificationSummary,
  saveVersionSnapshot,
  listVersions,
  loadVersion,
  propagate,
  formatPropagateSummary,
  createConfirmationTracker,
} from '../versioner/index.js';
import { specify, specsFromEnvelope, envelopeMigrate, isSpecsEnvelope } from '../specifier/index.js';
import {
  resolveBindings,
  validateBindings,
  applyBindingEnvironment,
  mergeBindings,
} from '../binder/index.js';
import { deriveBindings, isSkeletonBindings, SKELETON_MARKER, type SkeletonBindings } from '../bindgen/index.js';
import { deriveWeb, WEB_DATA_SCHEMA_VERSION } from '../webgen/index.js';
import { startServe } from '../webgen/serve.js';
import { loadScenarioParams, findScenariosDir } from '../verifier/binding-runner.js';
import { writeEnvDepsReport, formatEnvDepsWarnings } from '../verifier/env-deps.js';
import { loadTestTool } from '../testtool/loader.js';
import { runMCheck, formatMCheckReport, mCheckCli } from '../mcheck/index.js';
import { runTestCasesWithTestTool } from '../testtool/runner.js';
import { buildVerificationReportFromTestTool } from '../verifier/index.js';
import { readReport, writeReport } from '../orchestrator/index.js';
import type { StepId, AIAdapter, InterfaceSpec, TestCaseSet, CompositionCompletenessReport, SourceProtocolModel } from '../model/types.js';

/**
 * 加载 + 兼容老格式 specs.json —— E2 specs.json envelope 兼容读
 * - 读 derived/specs.json
 * - 是 Envelope → 返回 specs
 * - 是裸 InterfaceSpec[] / 其他形态 → envelopeMigrate 提升
 * - 文件不存在 → 回退到 deriveFn()
 *
 * 迁移报警通过 stderr 打印一次（CLI 友好），不影响 specs 数组
 */
function loadSpecsOrMigrate(
  rootDir: string,
  model: SourceProtocolModel,
  deriveFn: () => InterfaceSpec[]
): InterfaceSpec[] {
  const raw = readReport<unknown>(rootDir, 'derived/specs.json');
  if (raw !== undefined) {
    if (isSpecsEnvelope(raw)) {
      return raw.specs;
    }
    const r = envelopeMigrate(raw, model.metadata.version);
    if (r.migrated && r.warnings.length > 0) {
      for (const w of r.warnings) {
        console.warn(`[specs.json] [migration] ${w}`);
      }
    }
    return r.envelope.specs;
  }
  return deriveFn();
}

/**
 * 从 model + specs 推导出 legacyExpectedResponses（E2-I4 修复）。
 *
 * 设计：
 * - 数据源分两层：
 *   1. model.contractInput.expectedInformationFields（USAGE §4.2 契约层段）：
 *      每个 action 的响应应包含这些信息字段；缺则视为字段级偏差
 *   2. model.derivable.invariants[].id：每个 action 在响应中验证该不变量保持
 *      （值由具体 impl 提供，不在 helper 内填具体值；仅声明「应保持」）
 * - 输出形态：{ actionName: { field1: '<expected>', invariant1: '<expected>' } }
 * - override 机制：scenarios/*.yaml.expectedFields 若存在则覆盖（E2.1 后续扩面）
 *
 * 注意：helper 不强行推测具体值（避免引入随机性 / 假阴性），仅标记「应包含此字段」。
 * 实际期望值由 scenarios 或 impl 行为决定；缺值时仅记 type-mismatch。
 */
function buildLegacyExpectedFromModel(
  model: SourceProtocolModel,
  specs: InterfaceSpec[]
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  const infoFields: string[] = model.contractInput?.expectedInformationFields ?? [];
  const invariantIds: string[] = model.derivable.invariants.map((inv) => inv.id);

  // 仅系统接口参与字段级对比（observation 接口无响应体外部期望）
  const systemSpecs = specs.filter((s) => s.kind === 'system');
  for (const spec of systemSpecs) {
    const action = spec.name;
    const expected: Record<string, unknown> = {};
    // 信息字段：用「__present」作 sentinel —— 字段存在性提示
    //   field-compare 暂不做 sentinel 比对；保留 entries 表示「此 action 的响应预期含这些字段」
    for (const f of infoFields) {
      expected[`__info_expected:${f}`] = true;
    }
    // 不变量 ID：同上，作为存在性提示
    for (const inv of invariantIds) {
      expected[`__invariant_expected:${inv}`] = true;
    }
    // 保留空对象语义：即使 model 缺 expectedInformationFields 也不阻断
    // 真实「字段 X：legacy=Y, impl=Z」值级三元组由 scenarios/*.yaml.expectedResponse 注入（E2.1 扩面）
    result[action] = expected;
  }
  // 注：真实值级对比保留 verify 调用处的显式 legacyExpectedResponses 注入；
  // 当前 CLI 不强制要求用户在配置层提供 —— 字段级对比仍可工作（仅基于 responseSchema 类型校验）。
  return result;
}

const program = new Command();

program
  .name('protochain')
  .description('协议驱动自验证工具链 - 方法论十步流程的可执行骨架')
  .version('0.1.0')
  .option('--protocol <Pn>', '多协议项目中指定子协议（如 P1；组合层命令无需指定）');

// ==========================================================================
// init
// ==========================================================================

program
  .command('init')
  .description('生成协议项目骨架 + 场景目录 + 配置文件')
  .requiredOption('-n, --name <协议名>', '协议名称')
  .option('-d, --dir <目录>', '目标根目录', process.cwd())
  .option('-f, --force', '覆盖已存在的文件')
  .action((opts) => {
    const rootDir = resolve(opts.dir);
    const result = initProject({ name: opts.name, rootDir, force: opts.force });
    console.log(`项目 "${opts.name}" 已初始化于 ${rootDir}`);
    console.log('创建目录:');
    for (const d of result.createdDirs) console.log(`  + ${d}/`);
    console.log('创建文件:');
    for (const f of result.createdFiles) console.log(`  + ${f}`);
    console.log('\n下一步：编辑 protocol/model.md 填写协议内容，然后运行 protochain check');
  });

// ==========================================================================
// init-multi（生成多协议系统骨架）
// ==========================================================================

program
  .command('init-multi')
  .description('生成多协议系统骨架（组合层 + 各子协议骨架）')
  .requiredOption('-s, --system <系统名>', '系统名称')
  .requiredOption('-p, --protocols <列表>', '子协议列表，格式 P1:名称1,P2:名称2')
  .option('-d, --dir <目录>', '目标根目录', process.cwd())
  .option('-f, --force', '覆盖已存在的文件')
  .action((opts) => {
    const rootDir = resolve(opts.dir);
    // 解析 "P1:名称1,P2:名称2"
    const protocols = opts.protocols.split(',').map((s: string) => {
      const [pid, ...nameParts] = s.trim().split(':');
      const name = nameParts.join(':').trim() || pid.trim();
      return { protocolId: pid.trim(), name };
    });
    const result = initMultiProject({
      systemName: opts.system,
      rootDir,
      protocols,
      force: opts.force,
    });
    console.log(`多协议系统 "${opts.system}" 已初始化于 ${rootDir}`);
    console.log('创建目录:');
    for (const d of result.createdDirs) console.log(`  + ${d}/`);
    console.log('创建文件:');
    for (const f of result.createdFiles) console.log(`  + ${f}`);
    console.log(
      '\n下一步：编辑各子协议 protocol/<Pn>/model.md 与 protocol/composition.md，然后运行 protochain check-composition'
    );
  });

// ==========================================================================
// check（单步执行：① 完备性检查）
// ==========================================================================

program
  .command('check')
  .description('① 完备性检查（机械层代码执行 + 语义层 AI 执行）')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option('--no-ai', '仅执行机械层，跳过语义层 AI 检查')
  .action(async (opts) => {
    const ctx = resolveCtx(opts);
    const rootDir = ctx.protocolRoot;
    const modelPath = ctx.modelPath;
    try {
      const model = parseProtocolFile(modelPath);
      const report = checkCompleteness(model);

      if (opts.ai && report.mechanical.passed) {
        const config = loadConfig(rootDir);
        if (config.ai) {
          try {
            // 多模型路由：语义层检查用便宜模型
            const adapter = createAIRouter(config.ai).get('semantic');
            console.log('执行语义层 AI 检查...');
            const semantic = await checkSemanticCompleteness(model, adapter);
            report.semantic = semantic;
            // 语义层为 advisory（问题清单 #10）：AI 判定跨 run 非确定，不阻断
            report.passed = report.mechanical.passed;
          } catch (err) {
            console.warn(
              `AI 适配器初始化失败，跳过语义层：${err instanceof Error ? err.message : err}`
            );
          }
        } else {
          console.log('未配置 AI 适配器，仅执行机械层（可在 protochain.config.yaml 配置 ai）');
        }
      }

      writeReport(rootDir, 'derived/completeness-report.json', report);
      printCheckReport(report);
      process.exit(report.passed ? 0 : 1);
    } catch (err) {
      console.error(
        `错误：${err instanceof Error ? err.message : err}`
      );
      process.exit(2);
    }
  });

// ==========================================================================
// check-composition（①-C 组合层完备性检查）
// ==========================================================================

program
  .command('check-composition')
  .description('①-C 组合层完备性检查（机械层 + 语义层 AI）')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option('--no-ai', '仅执行机械层，跳过语义层 AI 检查')
  .action(async (opts) => {
    const rootDir = resolveCtx(opts, 'composition').systemRoot;
    const compositionPath = join(rootDir, 'protocol/composition.md');
    try {
      const composition = parseCompositionFile(compositionPath);

      // 收集各子协议 ① 阶段标记的 pendingCrossProtocolRefs
      const pendingRefs: PendingRefWithSource[] = [];
      const subProtocolModels = [];
      for (const sp of composition.subProtocols) {
        const report = readReport<{
          pendingCrossProtocolRefs?: PendingRefWithSource[];
        }>(
          rootDir,
          `protocol/${sp.protocolId}/derived/completeness-report.json`
        );
        if (report?.pendingCrossProtocolRefs) {
          for (const ref of report.pendingCrossProtocolRefs) {
            pendingRefs.push({ ...ref, sourceProtocol: sp.protocolId });
          }
        }
        // 加载子协议模型用于深度校验
        try {
          const model = parseProtocolFile(join(rootDir, sp.modelPath));
          subProtocolModels.push(model);
        } catch {
          // 子协议模型加载失败不阻塞
        }
      }

      let report = checkCompositionCompleteness(composition, pendingRefs, {
        subProtocolModels,
      });

      if (opts.ai && report.mechanical.passed) {
        const config = loadConfig(rootDir);
        if (config.ai) {
          try {
            // 多模型路由：组合层语义检查用便宜模型
            const adapter = createAIRouter(config.ai).get('semantic');
            console.log('执行组合层语义层 AI 检查...');
            const semantic = await checkCompositionSemantic(composition, adapter);
            report.semantic = semantic;
            // 语义层为 advisory（问题清单 #10）：AI 判定跨 run 非确定，不阻断
            report.passed = report.mechanical.passed;
          } catch (err) {
            console.warn(
              `AI 适配器初始化失败，跳过语义层：${err instanceof Error ? err.message : err}`
            );
          }
        } else {
          console.log('未配置 AI 适配器，仅执行机械层');
        }
      }

      printCompositionCheckReport(report);
      writeReport(
        rootDir,
        'derived/composition/completeness-report.json',
        report
      );
      process.exit(report.passed ? 0 : 1);
    } catch (err) {
      console.error(
        `错误：${err instanceof Error ? err.message : err}`
      );
      process.exit(2);
    }
  });

function printCompositionCheckReport(report: CompositionCompletenessReport): void {
  console.log('=== ①-C 组合层完备性检查报告 ===');
  console.log(`\n[机械层] ${report.mechanical.passed ? '通过' : '未通过'}`);
  const allIssues = [
    ...report.mechanical.structuralIssues,
    ...report.mechanical.fieldIssues,
    ...report.mechanical.referenceIssues,
  ];
  if (allIssues.length > 0) {
    console.log('  问题清单:');
    for (const issue of allIssues) {
      console.log(`  [${issue.severity}] ${issue.message}`);
    }
  }
  console.log(
    `\n[跨协议引用] 共 ${report.crossProtocolRefResults.length} 条，未解析 ${report.crossProtocolRefResults.filter((r) => !r.resolved).length} 条`
  );
  for (const r of report.crossProtocolRefResults) {
    const status = r.resolved ? '已解析' : '未解析';
    console.log(`  ${r.sourceProtocol}.${r.sourceField} → ${r.targetRef} [${status}]${r.error ? ' ' + r.error : ''}`);
  }
  if (report.semantic.executed) {
    console.log(`\n[语义层] ${report.semantic.passed ? '通过' : '未通过'}`);
    for (const issue of report.semantic.ambiguityIssues) {
      console.log(`  [歧义][${issue.severity}] ${issue.message}`);
    }
    for (const issue of report.semantic.duplicationIssues) {
      console.log(`  [重复][${issue.severity}] ${issue.message}`);
    }
  }
  console.log(`\n总体：${report.passed ? '通过' : '未通过'}`);
}

// ==========================================================================
// check-cross-invariants（②-C 跨协议不变量推演）
// ==========================================================================

program
  .command('check-cross-invariants')
  .description('②-C 跨协议不变量推演（代码实例化 + AI 辅助）')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option('--no-ai', '仅执行 simple_boolean 检查，跳过 first_order AI 检查')
  .action(async (opts) => {
    const rootDir = resolveCtx(opts, 'composition').systemRoot;
    const compositionPath = join(rootDir, 'protocol/composition.md');
    try {
      const composition = parseCompositionFile(compositionPath);

      // 加载各子协议模型
      const subProtocolModels = [];
      for (const sp of composition.subProtocols) {
        try {
          const model = parseProtocolFile(join(rootDir, sp.modelPath));
          subProtocolModels.push(model);
        } catch {
          console.warn(`子协议 ${sp.protocolId} 模型加载失败，跳过`);
        }
      }

      // 配置 AI 适配器（仅 first_order 不变量需要）
      let adapter = undefined;
      if (opts.ai) {
        const config = loadConfig(rootDir);
        if (config.ai) {
          try {
            adapter = createAIRouter(config.ai).get('semantic');
          } catch (err) {
            console.warn(
              `AI 适配器初始化失败，仅执行 simple_boolean 检查：${err instanceof Error ? err.message : err}`
            );
          }
        }
      }

      const report = await checkCrossInvariants(composition, {
        subProtocolModels,
        adapter,
      });

      printCrossInvariantReport(report);
      writeReport(rootDir, 'derived/cross-invariants-report.json', report);
      process.exit(report.passed ? 0 : 1);
    } catch (err) {
      console.error(`错误：${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
  });

function printCrossInvariantReport(report: import('../model/types.js').CrossInvariantReport): void {
  console.log('=== ②-C 跨协议不变量推演报告 ===');
  console.log(`\n结果：${report.passed ? '通过' : '未通过'}`);
  for (const r of report.results) {
    const status = r.passed ? '通过' : '未通过';
    console.log(`  ${r.invariantId} [${r.checkMethod}]: ${status}`);
    if (r.counterexample) {
      console.log(`    反例：${r.counterexample}`);
    }
  }
  if (report.instantiatedStateSummary) {
    console.log(`\n状态实例化摘要：`);
    console.log(report.instantiatedStateSummary);
  }
}

// ==========================================================================
// formalize-cross（③-C 跨协议形式化验证）
// ==========================================================================

program
  .command('formalize-cross')
  .description('③-C 跨协议形式化验证（生成全局 TLA+ 规格）')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option('--no-ai', '仅生成骨架，跳过 AI 填充')
  .action(async (opts) => {
    const rootDir = resolveCtx(opts, 'composition').systemRoot;
    const compositionPath = join(rootDir, 'protocol/composition.md');
    try {
      const composition = parseCompositionFile(compositionPath);

      // 加载各子协议模型
      const subProtocolModels = [];
      for (const sp of composition.subProtocols) {
        try {
          const model = parseProtocolFile(join(rootDir, sp.modelPath));
          subProtocolModels.push(model);
        } catch {
          console.warn(`子协议 ${sp.protocolId} 模型加载失败，跳过`);
        }
      }

      // 配置 AI 适配器
      let adapter = undefined;
      if (opts.ai) {
        const config = loadConfig(rootDir);
        if (config.ai) {
          try {
            adapter = createAIRouter(config.ai).get('reasoning');
          } catch (err) {
            console.warn(
              `AI 适配器初始化失败，仅生成骨架：${err instanceof Error ? err.message : err}`
            );
          }
        }
      }

      const report = await crossFormalize(composition, {
        subProtocolModels,
        adapter,
      });

      printCrossFormalReport(report);
      writeReport(rootDir, 'derived/composition/formal-report.json', report);
      process.exit(0); // ③-C 为可选步骤，不阻塞

    } catch (err) {
      console.error(`错误：${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
  });

function printCrossFormalReport(report: import('../model/types.js').FormalReport): void {
  console.log('=== ③-C 跨协议形式化验证报告 ===');
  console.log(`工具：${report.tool}`);
  console.log(`适合度评分：${report.suitabilityScore}`);
  console.log(`通过：${report.passed ? '是' : '否'}`);
  console.log(`\n规格片段（前 500 字符）：`);
  console.log(report.generatedSpec.slice(0, 500));
  if (report.generatedSpec.length > 500) console.log('...');
}

// ==========================================================================
// derive-cross-contracts（④-C 跨协议契约推导）
// ==========================================================================

program
  .command('derive-cross-contracts')
  .description('④-C 跨协议契约推导（事件契约 + 影响范围 + 补偿契约 + 时序契约）')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .action(async (opts) => {
    const rootDir = resolveCtx(opts, 'composition').systemRoot;
    const compositionPath = join(rootDir, 'protocol/composition.md');
    try {
      const composition = parseCompositionFile(compositionPath);
      const contracts = deriveCrossContracts(composition);
      console.log('=== ④-C 跨协议契约推导报告 ===');
      console.log(`  事件契约：${contracts.eventContracts.length} 条`);
      for (const c of contracts.eventContracts) {
        console.log(`    ${c.id}: ${c.fromProtocol} → ${c.toProtocol} [${c.event}]`);
      }
      console.log(`  影响范围契约：${contracts.impactContracts.length} 条`);
      for (const c of contracts.impactContracts) {
        console.log(`    ${c.id}: source=${c.sourceEvent} affects=[${c.affectedProtocols.join(',')}]`);
      }
      console.log(`  补偿契约：${contracts.compensationContracts.length} 条`);
      console.log(`  时序契约：${contracts.timingContracts.length} 条`);
      for (const c of contracts.timingContracts) {
        console.log(`    ${c.id}: span=[${c.span.join(',')}] rule=${c.rule}`);
      }
      writeReport(rootDir, 'derived/composition/cross-contracts.json', contracts);
      process.exit(0);
    } catch (err) {
      console.error(`错误：${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
  });

// ==========================================================================
// generate-cross-cases（⑦-C 跨协议测试用例生成）
// ==========================================================================

program
  .command('generate-cross-cases')
  .description('⑦-C 跨协议测试用例生成（跨协议路径遍历）')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .action(async (opts) => {
    const rootDir = resolveCtx(opts, 'composition').systemRoot;
    const compositionPath = join(rootDir, 'protocol/composition.md');
    try {
      const composition = parseCompositionFile(compositionPath);
      const subProtocolModels = [];
      for (const sp of composition.subProtocols) {
        try {
          subProtocolModels.push(parseProtocolFile(join(rootDir, sp.modelPath)));
        } catch { /* 忽略 */ }
      }
      const cases = generateCrossCases(composition, subProtocolModels);
      console.log('=== ⑦-C 跨协议测试用例生成报告 ===');
      console.log(`  路径数：${cases.paths.length}`);
      for (const p of cases.paths) {
        const segSummary = p.segments.map((s) => `${s.protocolId}[${s.stateIds.join(',')}]`).join(' → ');
        console.log(`    ${p.id}: ${segSummary}`);
      }
      console.log(`  事件覆盖：${cases.coverage.eventCoverage.covered}/${cases.coverage.eventCoverage.total}`);
      console.log(`  不变量覆盖：${cases.coverage.invariantCoverage.covered}/${cases.coverage.invariantCoverage.total}`);
      writeReport(rootDir, 'derived/composition/cross-cases.json', cases);
      process.exit(0);
    } catch (err) {
      console.error(`错误：${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
  });

const VALID_STEPS: StepId[] = [
  'check',
  'reason',
  'formalize',
  'derive-specs',
  'derive-contracts',
  'generate-tests',
  'generate-cases',
  'check-impl',
  'verify',
];

program
  .command('run')
  .description('按步骤依赖 DAG 执行流程区间')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option('--from <步骤>', '起始步骤', 'check')
  .option('--to <步骤>', '结束步骤', 'verify')
  .option('--no-ai', '禁用 AI（仅执行确定性步骤）')
  .option('--env <名称>', '绑定环境（bindings.environments；默认 defaultEnv）')
  .option('-y, --yes', '自动批准检查点（非交互）')
  .action(async (opts) => {
    const ctx = resolveCtx(opts);
    const rootDir = ctx.protocolRoot;
    const from = opts.from as StepId;
    const to = opts.to as StepId;

    if (!VALID_STEPS.includes(from)) {
      console.error(`无效的 --from 步骤：${from}`);
      console.error(`可选值：${VALID_STEPS.join(', ')}`);
      process.exit(2);
    }
    if (!VALID_STEPS.includes(to)) {
      console.error(`无效的 --to 步骤：${to}`);
      process.exit(2);
    }

    // 注册已实现的步骤执行器
    registerStepExecutors(rootDir, opts.ai, ctx.protocolId, opts.env);

    // 检查 from 之前的步骤是否已实现
    const fromExecutor = getExecutor(from);
    if (!fromExecutor) {
      console.error(`步骤 ${from} 尚未实现（P2-P4 待实现）`);
      process.exit(2);
    }

    const checkpointHandler = opts.yes
      ? undefined
      : createInteractiveCheckpointHandler();

    try {
      const result = await runPipeline({
        rootDir,
        from,
        to,
        modelPath: ctx.modelPath,
        protocolId: ctx.protocolId,
        checkpointHandler,
      });

      console.log(`执行完成：${result.executed.join(' → ')}`);
      if (result.aborted) {
        console.error(`流程中止于 ${result.aborted.stepId}：${result.aborted.reason}`);
        process.exit(1);
      }
      process.exit(0);
    } catch (err) {
      console.error(`错误：${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
  });

// ==========================================================================
// status
// ==========================================================================

program
  .command('status')
  .description('查看待确认项、步骤进度、检查点状态')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .action((opts) => {
    const rootDir = resolveCtx(opts).protocolRoot;
    const state = loadState(rootDir);
    const view = buildStatusView(state);
    console.log(formatStatusView(view));
  });

// ==========================================================================
// exec-task（子任务模式：protocol-runner 驱动 protochain 的结构化边界）
// ==========================================================================

program
  .command('exec-task <taskFile>')
  .description('子任务模式：消费结构化 task.json，执行请求步骤并写回结构化 result.json（不执行权威 acceptance）')
  .option('--result <path>', 'result.json 输出路径（默认 <taskFile>.result.json）')
  .option('--dir <目录>', 'protochain 项目根（默认取 task.json.projectDir，否则 cwd）')
  .option('--protocol <Pn>', '多协议项目中的子协议 ID（如 P1；覆盖 task.json.protocolId）')
  .option('--persist-state', '执行后写 orchestrator-state.yaml（兼容既有 acceptance；默认无状态）')
  .option('--no-ai', '禁用 AI（覆盖 task.useAI；默认仅当 task.useAI 且配置 ai 时启用）')
  .action(async (taskFile: string, opts: { result?: string; dir?: string; protocol?: string; persistState?: boolean; ai: boolean }) => {
    const taskPath = resolve(taskFile);
    let task: ExecTaskInput;
    try {
      task = JSON.parse(readFileSync(taskPath, 'utf8')) as ExecTaskInput;
    } catch (err) {
      console.error(`错误：无法读取 task.json ${taskPath}：${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
    const projectDir = resolve(opts.dir ?? task.projectDir ?? process.cwd());
    const resultPath = resolve(opts.result ?? `${taskPath}.result.json`);
    // --no-ai 显式禁用（opts.ai=false）；未传时按 task.useAI 决定
    const useAI = opts.ai === true && task.useAI === true;
    const persistState = opts.persistState === true || task.persistState === true;
    const result = await executeTask(
      { ...task, useAI, protocolId: opts.protocol ?? task.protocolId },
      { projectDir, persistState }
    );
    writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
    console.log(result.summary);
    console.log(`result 已写入: ${resultPath}`);
    process.exit(result.status === 'completed' ? 0 : 1);
  });

// ==========================================================================
// config
// ==========================================================================

const configCmd = program.command('config').description('配置管理');

configCmd
  .command('set <key> <value>')
  .description('设置配置项（如 ai.provider openai）')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .action((key: string, value: string, opts: { dir: string }) => {
    const rootDir = resolve(opts.dir);
    const config = loadConfig(rootDir);
    setConfigValue(config, key, value);
    saveConfig(rootDir, config);
    console.log(`已设置 ${key} = ${value}`);
  });

configCmd
  .command('get [key]')
  .description('读取配置项')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .action((key: string | undefined, opts: { dir: string }) => {
    const rootDir = resolve(opts.dir);
    const config = loadConfig(rootDir);
    if (key) {
      const parts = key.split('.');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let target: any = config;
      for (const part of parts) {
        target = target?.[part];
        if (target === undefined) break;
      }
      console.log(target === undefined ? `(未设置)` : JSON.stringify(target));
    } else {
      console.log(JSON.stringify(config, null, 2));
    }
  });

// ==========================================================================
// reason（单步执行：② AI 推演）
// ==========================================================================

program
  .command('reason')
  .description('② AI 推演（可达性/死锁/活性/一致性）')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option('-l, --liveness <模式>', '活性判定模式：weak|strong（默认按模型声明或 weak）')
  .action(async (opts) => {
    const ctx = resolveCtx(opts);
    const rootDir = ctx.protocolRoot;
    const modelPath = ctx.modelPath;
    const config = loadConfig(rootDir);
    if (!config.ai) {
      console.error('步骤 ② AI 推演需要 AI 适配器，请在 protochain.config.yaml 配置 ai');
      process.exit(2);
    }
    let liveness: 'weak' | 'strong' | undefined;
    if (opts.liveness !== undefined) {
      if (opts.liveness !== 'weak' && opts.liveness !== 'strong') {
        console.error(`--liveness 必须是 weak 或 strong，实际为 ${opts.liveness}`);
        process.exit(2);
      }
      liveness = opts.liveness;
    }
    let aiAdapter: AIAdapter;
    try {
      aiAdapter = createAIRouter(config.ai).get('reasoning');
    } catch (err) {
      console.error(`AI 适配器初始化失败：${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
    registerExecutor('reason', createReasonExecutor(aiAdapter, { liveness }));

    // 直接调用执行器
    const { parseProtocolFile } = await import('../parser/index.js');
    const model = parseProtocolFile(modelPath);
    const { writeReport } = await import('../orchestrator/index.js');
    const result = await (await import('../steps/reason.js'))
      .createReasonExecutor(aiAdapter, { liveness })
      .execute({
        model,
        rootDir,
        artifacts: {},
      });

    if (result.reportSummary) console.log(result.reportSummary);
    process.exit(result.passed ? 0 : 1);
  });

// ==========================================================================
// formalize（单步执行：③ 形式化验证）
// ==========================================================================

program
  .command('formalize')
  .description('③ 形式化验证（多工具适配：TLA+/SCXML/决策表）')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option('--tool <工具>', '指定形式化工具（tla|scxml|decision-table|auto）', 'auto')
  .action(async (opts) => {
    const ctx = resolveCtx(opts);
    const rootDir = ctx.protocolRoot;
    const modelPath = ctx.modelPath;
    const config = loadConfig(rootDir);
    if (opts.tool !== 'auto') {
      config.formalTool = opts.tool as 'tla' | 'scxml' | 'decision-table';
    }
    if (!config.ai) {
      console.error('步骤 ③ 形式化验证需要 AI 适配器');
      process.exit(2);
    }
    let aiAdapter: AIAdapter;
    try {
      aiAdapter = createAIRouter(config.ai).get('reasoning');
    } catch (err) {
      console.error(`AI 适配器初始化失败：${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }

    const { parseProtocolFile } = await import('../parser/index.js');
    const model = parseProtocolFile(modelPath);
    const result = await (await import('../steps/formalize.js')).createFormalizeExecutor(aiAdapter, config).execute({
      model,
      rootDir,
      artifacts: {},
    });

    if (result.reportSummary) console.log(result.reportSummary);
    process.exit(result.passed ? 0 : 1);
  });

// ==========================================================================
// derive-specs（单步执行：⑤ 规格推导）
// ==========================================================================

program
  .command('derive-specs')
  .description('⑤ 规格推导（代码确定性执行：动作→系统接口，状态/不变量→观测接口）')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .action(async (opts) => {
    const ctx = resolveCtx(opts);
    const rootDir = ctx.protocolRoot;
    const model = parseProtocolFile(ctx.modelPath);
    const result = await createSpecifyExecutor().execute({
      model,
      rootDir,
      artifacts: {},
    });
    if (result.passed && result.outputs && result.outputs.length > 0) {
      recordManifest(rootDir, {
        stepId: result.stepId,
        sourceModelVersion: model.metadata.version,
        generatedAt: result.executedAt,
        artifacts: result.outputs,
      });
    }
    // E2：告知用户 specs.json 升级状态
    if (result.passed) {
      console.log('');
      console.log('✓ specs.json 已升到 JSON Schema（schemaVersion=1.0）；verify 默认启用字段级对比。');
    }
    if (result.reportSummary) console.log(result.reportSummary);
    process.exit(result.passed ? 0 : 1);
  });

// ==========================================================================
// derive-contracts（单步执行：④ 契约推导）
// ==========================================================================

program
  .command('derive-contracts')
  .description('④ 契约推导（代码投影 + AI 辅助不变量相关性判断）')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option('--no-ai', '禁用 AI（仅执行代码投影，不调用 AI 判断不变量相关性）')
  .action(async (opts) => {
    const ctx = resolveCtx(opts);
    const rootDir = ctx.protocolRoot;
    const config = loadConfig(rootDir);
    let aiAdapter: AIAdapter | undefined = undefined;
    if (opts.ai && config.ai) {
      try {
        aiAdapter = createAIRouter(config.ai).get('reasoning');
      } catch (err) {
        console.warn(
          `AI 适配器初始化失败，跳过 AI 辅助：${err instanceof Error ? err.message : err}`
        );
      }
    }

    const model = parseProtocolFile(ctx.modelPath);
    const result = await createContractExecutor(aiAdapter).execute({
      model,
      rootDir,
      artifacts: {},
    });
    if (result.passed && result.outputs && result.outputs.length > 0) {
      recordManifest(rootDir, {
        stepId: result.stepId,
        sourceModelVersion: model.metadata.version,
        generatedAt: result.executedAt,
        artifacts: result.outputs,
      });
    }
    if (result.reportSummary) console.log(result.reportSummary);
    process.exit(result.passed ? 0 : 1);
  });

// ==========================================================================
// generate-tests（单步执行：⑥ 测试工具生成）
// ==========================================================================

program
  .command('generate-tests')
  .description('⑥ 测试工具生成（生成场景加载器/协议执行器/一致性断言器/协议模型源码）')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .action(async (opts) => {
    const ctx = resolveCtx(opts);
    const rootDir = ctx.protocolRoot;
    const config = loadConfig(rootDir);
    let aiAdapter: AIAdapter | undefined = undefined;
    if (config.ai) {
      try {
        aiAdapter = createAIRouter(config.ai).get('generation');
      } catch (err) {
        console.warn(
          `AI 适配器初始化失败，使用纯代码生成：${err instanceof Error ? err.message : err}`
        );
      }
    }

    const model = parseProtocolFile(ctx.modelPath);
    const result = await createTestGenExecutor(aiAdapter, config).execute({
      model,
      rootDir,
      artifacts: {},
    });
    if (result.passed && result.outputs && result.outputs.length > 0) {
      recordManifest(rootDir, {
        stepId: result.stepId,
        sourceModelVersion: model.metadata.version,
        generatedAt: result.executedAt,
        artifacts: result.outputs,
      });
    }
    if (result.reportSummary) console.log(result.reportSummary);
    process.exit(result.passed ? 0 : 1);
  });

// ==========================================================================
// generate-cases（单步执行：⑦ 测试用例生成）
// ==========================================================================

program
  .command('generate-cases')
  .description('⑦ 测试用例生成（协议路径遍历 + 覆盖度准则 + 循环检测）')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option(
    '--criterion <准则>',
    '覆盖度准则（state|transition|path）',
    'state'
  )
  .option('--max-path-length <数>', '最大路径长度（path 准则时生效）')
  .action(async (opts) => {
    const ctx = resolveCtx(opts);
    const rootDir = ctx.protocolRoot;
    const config = loadConfig(rootDir);
    // 命令行参数覆盖配置
    const criterion = (opts.criterion as 'state' | 'transition' | 'path') ?? config.coverage?.criterion ?? 'state';
    const maxPathLength = opts.maxPathLength
      ? Number(opts.maxPathLength)
      : config.coverage?.maxPathLength;
    config.coverage = {
      criterion,
      ...(maxPathLength !== undefined ? { maxPathLength } : {}),
    };

    let aiAdapter: AIAdapter | undefined = undefined;
    if (config.ai?.useForGeneration) {
      try {
        aiAdapter = createAIRouter(config.ai).get('generation');
      } catch (err) {
        console.warn(
          `AI 适配器初始化失败，使用确定性路径生成：${err instanceof Error ? err.message : err}`
        );
      }
    }

    const model = parseProtocolFile(ctx.modelPath);
    const result = await createCaseGenExecutor(config, aiAdapter).execute({
      model,
      rootDir,
      artifacts: {},
    });
    if (result.reportSummary) console.log(result.reportSummary);
    process.exit(result.passed ? 0 : 1);
  });

// ==========================================================================
// generate-scaffold（单步执行：⑨ 从接口规格生成实现类型骨架）
// ==========================================================================

program
  .command('generate-scaffold')
  .description('⑨ 从接口规格生成实现类型骨架（interfaces.d.ts）')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option('-o, --output <路径>', '输出文件路径（默认 <协议根>/impl-scaffold/interfaces.d.ts）')
  .action((opts) => {
    const ctx = resolveCtx(opts);
    const rootDir = ctx.protocolRoot;
    try {
      const model = parseProtocolFile(ctx.modelPath);
      const specs = loadSpecsOrMigrate(rootDir, model, () => specsFromEnvelope(specify(model)));
      const outputPath = opts.output
        ? resolve(opts.output)
        : join(rootDir, 'impl-scaffold/interfaces.d.ts');
      scaffoldInterfaces({ specs, outputPath });
      console.log(`接口骨架已生成于 ${outputPath}`);
      console.log(`  接口数: ${specs.length}`);
      console.log('下一步：开发者填充实现逻辑，然后运行 protochain check-impl');
      process.exit(0);
    } catch (err) {
      console.error(`错误：${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
  });

// ==========================================================================
// check-impl（单步执行：⑧ 实现完整性检查）
// ==========================================================================

program
  .command('check-impl')
  .description('⑧ 实现完整性检查（代码确定性执行，校验接口存在性）')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option('--src <dir...>', '额外的实现源文件目录（相对系统根解析；默认 src/impl 及子协议本地实现目录）')
  .action(async (opts) => {
    const ctx = resolveCtx(opts);
    const rootDir = ctx.protocolRoot;
    try {
      const model = parseProtocolFile(ctx.modelPath);
      const specs = loadSpecsOrMigrate(rootDir, model, () => specsFromEnvelope(specify(model)));
      // --src 覆盖默认目录；所有目录统一相对系统根解析（兼容绝对路径）
      const extraDirs = (
        Array.isArray(opts.src) ? opts.src : opts.src ? [opts.src] : []
      ).map((d: string) => resolve(ctx.systemRoot, d));
      const defaultDirs =
        ctx.mode === 'multi'
          ? ['src', 'impl', `protocol/${ctx.protocolId}/src`, `protocol/${ctx.protocolId}/impl`]
          : ['src', 'impl'];
      const sourceDirs =
        extraDirs.length > 0
          ? extraDirs
          : defaultDirs.map((d) => join(ctx.systemRoot, d));
      const report = checkImplementation(specs, rootDir, { sourceDirs });
      writeReport(rootDir, 'derived/impl-check/impl-check-report.json', report);
      console.log(formatImplCheckSummary(report));
      process.exit(report.passed ? 0 : 1);
    } catch (err) {
      console.error(`错误：${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
  });

// ==========================================================================
// bind（校验接口绑定完整性）
// ==========================================================================

program
  .command('bind')
  .description('校验 bindings 配置与 ⑤ 规格的接口绑定完整性')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option('--env <名称>', '绑定环境（bindings.environments；默认 defaultEnv）')
  .option('--skeleton <路径>', 'E3 骨架 YAML 路径（提供时自动 mergeBindings 后再校验）')
  .action((opts) => {
    const ctx = resolveCtx(opts);
    const rootDir = ctx.protocolRoot;
    try {
      const config = loadConfig(rootDir);
      if (!config.bindings) {
        console.error('未配置 bindings（请在 protochain.config.yaml 添加 bindings 段）');
        process.exit(2);
      }
      const envLabel = opts.env ?? config.bindings.defaultEnv ?? '(默认)';

      // E3：--skeleton 模式 → mergeBindings(skeleton, manual)
      // E3-I2 修复：相对路径统一相对 rootDir 解析（与默认路径落点一致），
      // 绝对路径仍按原语义处理。
      let effectiveBindings = config.bindings;
      let skeletonUsed = false;
      if (opts.skeleton) {
        const skeletonPath = resolveRelative(opts.skeleton, rootDir);
        if (!existsSync(skeletonPath)) {
          console.error(`--skeleton 文件不存在: ${skeletonPath}`);
          process.exit(2);
        }
        const skeletonRaw = parseYaml(readFileSync(skeletonPath, 'utf-8')) as unknown;
        if (!isSkeletonBindings(skeletonRaw)) {
          console.error(
            `--skeleton 文件不是 E3 骨架（缺少 ${SKELETON_MARKER} 标记）: ${skeletonPath}`
          );
          process.exit(2);
        }
        const skeleton = skeletonRaw as SkeletonBindings;
        effectiveBindings = mergeBindings(skeleton, config.bindings);
        skeletonUsed = true;
      }

      const envBindings = applyBindingEnvironment(effectiveBindings, opts.env);
      const model = parseProtocolFile(ctx.modelPath);
      const specs = loadSpecsOrMigrate(rootDir, model, () => specsFromEnvelope(specify(model)));
      const report = validateBindings(specs, envBindings, ctx.protocolId);
      console.log('=== 接口绑定完整性校验 ===');
      console.log(`  绑定环境: ${envLabel}`);
      if (skeletonUsed) {
        console.log(`  E3 骨架合并: ✓（已与 manual bindings 合并）`);
      }
      console.log(`  规格接口总数: ${specs.length}`);
      console.log(
        `  缺失系统接口: ${report.missingSystem.length > 0 ? report.missingSystem.join(', ') : '无'}`
      );
      console.log(
        `  缺失观测接口: ${report.missingObservation.length > 0 ? report.missingObservation.join(', ') : '无'}`
      );
      if (report.warnings.length > 0) {
        console.log('  警告:');
        for (const w of report.warnings) console.log(`    - ${w}`);
      }
      console.log(`\n总体：${report.valid ? '✓ 通过' : '✗ 未通过'}`);
      process.exit(report.valid ? 0 : 1);
    } catch (err) {
      console.error(`错误：${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
  });

// ==========================================================================
// verify（单步执行：⑩ 一致性验证）
// ==========================================================================

program
  .command('verify')
  .description('⑩ 一致性验证（运行测试工具，收集协议驱动断言结果）')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option('--no-ai', '禁用 AI 辅助摘要')
  .option('--env <名称>', '绑定环境（bindings.environments；默认 defaultEnv）')
  .action(async (opts) => {
    const ctx = resolveCtx(opts);
    const rootDir = ctx.protocolRoot;
    const config = loadConfig(rootDir);
    let aiAdapter: AIAdapter | undefined = undefined;
    if (opts.ai && config.ai) {
      try {
        aiAdapter = createAIRouter(config.ai).get('semantic');
      } catch (err) {
        console.warn(
          `AI 适配器初始化失败，跳过 AI 摘要：${err instanceof Error ? err.message : err}`
        );
      }
    }
    try {
      // 绑定环境解析 + 前置环境变量扫描与告警（不阻断）
      const bindings = config.bindings
        ? applyBindingEnvironment(config.bindings, opts.env)
        : undefined;
      const envLabel = opts.env ?? config.bindings?.defaultEnv ?? '(默认)';
      if (bindings) {
        const envReport = writeEnvDepsReport(rootDir, bindings, ctx.protocolId, opts.env);
        const warning = formatEnvDepsWarnings(envReport);
        if (warning) console.warn(`\n[verify] ${warning}\n`);
      }
      console.log(`验证环境: ${envLabel}`);
      const model = parseProtocolFile(ctx.modelPath);
      const testCases = readReport<TestCaseSet>(rootDir, 'derived/test-cases.json');
      const specs = loadSpecsOrMigrate(rootDir, model, () => specsFromEnvelope(specify(model)));
      const scenariosDir = findScenariosDir(rootDir);
      // ── E2：specs.json 是新 Envelope → 启用字段级对比；老格式 migrate 后沿用 state_mismatch ──
      const rawSpecsJson = readReport<unknown>(rootDir, 'derived/specs.json');
      const useFieldLevel =
        rawSpecsJson !== undefined && isSpecsEnvelope(rawSpecsJson) === true;

      // ── E2-I4 修复：legacyExpectedResponses 数据源 ──
      // 协议侧（legacy）期望字段值，从 model.contractInput.expectedInformationFields 出发
      // 映射给每个系统接口：
      //   - 信息字段（expectedInformationFields）→ 每个 action 在响应中验证这些字段存在
      //   - 不变量 ID（model.derivable.invariants[].id）→ 每个 action 验证是否保持不变量
      // E2.1 后续扩面：可由 scenarios/*.yaml.expectedFields 覆盖具体期望值（保留 override 机制）
      const legacyExpectedResponses: Record<string, Record<string, unknown>> =
        buildLegacyExpectedFromModel(model, specs ?? []);

      const report = await verify(
        model,
        {
          rootDir,
          testCases: testCases ?? undefined,
          implementation: undefined,
          specs,
          bindings,
          protocolId: ctx.protocolId,
          scenarios: scenariosDir
            ? loadScenarioParams(scenariosDir)
            : undefined,
          enableFieldLevelCompare: useFieldLevel,
          legacyExpectedResponses,
        },
        aiAdapter,
        { useAISummary: !!aiAdapter }
      );
      writeReport(rootDir, 'derived/verification/verification-report.json', report);
      console.log(formatVerificationSummary(report));
      process.exit(report.authoritative.passed ? 0 : 1);
    } catch (err) {
      console.error(`错误：${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
  });

// ==========================================================================
// test-tool run（阶段 A 可执行入口：编译/import 生成 test-tool 并跑 test-cases）
// ==========================================================================

const testToolCmd = program
  .command('test-tool')
  .description('生成测试工具执行（阶段 A 可执行入口契约）');

testToolCmd
  .command('run')
  .description('执行生成测试工具：编译/import derived/test-tool 并按 test-cases.json 跑用例；权威结论来自代码确定性执行')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option('--impl <文件>', '实现模块：默认导出 ProtocolImplementation 对象，或 (path) => impl 工厂（实例层注入真实服务适配器）')
  .option('--limit <N>', '只跑前 N 条用例（阶段 B 先 dev 跑通一条）')
  .option('--out <文件>', '把 VerificationReport（含 authoritative.testTool 消费记录）写到指定 JSON 路径')
  .action(async (opts) => {
    const ctx = resolveCtx(opts);
    const rootDir = ctx.protocolRoot;
    const implFile = opts.impl;
    if (!implFile) {
      console.error('test-tool run 需要 --impl <文件>（实现模块）');
      process.exit(2);
    }
    try {
      const tool = await loadTestTool(rootDir, {
        nodeModulesDir: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules'),
      });
      const testCases = readReport<TestCaseSet>(rootDir, 'derived/test-cases.json');
      if (!testCases) {
        console.error(`缺少 test-cases.json: ${join(rootDir, 'derived/test-cases.json')}`);
        process.exit(2);
      }
      const implUrl = resolve(implFile);
      const implModule = (await import(pathToFileURL(implUrl).href)) as { default?: unknown };
      const implementation = implModule.default as Parameters<typeof runTestCasesWithTestTool>[2];
      const limit = opts.limit !== undefined ? Number(opts.limit) : undefined;
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        console.error('--limit 需为正整数');
        process.exit(2);
      }
      const run = await runTestCasesWithTestTool(tool, testCases, implementation, { limit });
      const report = buildVerificationReportFromTestTool(run);

      console.log(
        `test-tool 消费：executed=${run.executedCases} passed=${run.passedCases} failed=${run.failedCases}`,
      );
      console.log(`test-tool 文件: ${run.toolFiles.join(', ')}`);
      for (const c of run.caseResults.filter((r) => !r.passed)) {
        console.error(`  FAIL ${c.pathId}: ${c.error ?? '未通过'}`);
      }
      if (opts.out) {
        if (opts.out.startsWith('/')) {
          mkdirSync(dirname(opts.out), { recursive: true });
          writeFileSync(opts.out, JSON.stringify(report, null, 2) + '\n', 'utf8');
        } else {
          writeReport(rootDir, opts.out, report);
        }
        console.log(`VerificationReport 已写入: ${opts.out}`);
      }
      process.exit(report.authoritative.passed ? 0 : 1);
    } catch (err) {
      console.error(`错误：${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
  });

// ==========================================================================
// diff（差分引擎：比较两个版本的协议模型）
// ==========================================================================

program
  .command('diff')
  .description('差分引擎：比较两个版本的协议模型（含不变量 AI 语义等价判断）')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option('--old <版本号>', '旧版本号（默认当前 model.md 的版本）')
  .option('--new <版本号>', '新版本号（默认 protocol/versions/ 下最新版本）')
  .option('--no-ai', '禁用 AI 辅助不变量语义等价判断')
  .action(async (opts) => {
    const ctx = resolveCtx(opts);
    const rootDir = ctx.protocolRoot;
    const config = loadConfig(rootDir);
    let aiAdapter: AIAdapter | undefined = undefined;
    if (opts.ai && config.ai) {
      try {
        aiAdapter = createAIRouter(config.ai).get('semantic');
      } catch (err) {
        console.warn(`AI 适配器初始化失败：${err instanceof Error ? err.message : err}`);
      }
    }
    try {
      // 解析旧版本
      let oldModel: import('../model/types.js').SourceProtocolModel;
      if (opts.old) {
        const loaded = loadVersion(rootDir, opts.old, ctx.versionsDir);
        if (!loaded) {
          console.error(`版本 ${opts.old} 不存在`);
          process.exit(2);
        }
        oldModel = loaded;
      } else {
        // 默认当前 model.md 为旧版本
        oldModel = parseProtocolFile(ctx.modelPath);
      }

      // 解析新版本
      let newModel: import('../model/types.js').SourceProtocolModel;
      if (opts.new) {
        const loaded = loadVersion(rootDir, opts.new, ctx.versionsDir);
        if (!loaded) {
          console.error(`版本 ${opts.new} 不存在`);
          process.exit(2);
        }
        newModel = loaded;
      } else {
        // 默认 versions/ 下最新版本
        const versions = listVersions(rootDir, ctx.versionsDir);
        if (versions.length === 0) {
          console.error('未找到版本快照，请先运行 protochain version save');
          process.exit(2);
        }
        const latest = versions[versions.length - 1];
        const loaded = loadVersion(rootDir, latest.version, ctx.versionsDir);
        if (!loaded) {
          console.error(`版本 ${latest.version} 加载失败`);
          process.exit(2);
        }
        newModel = loaded;
      }

      const result = await diffModels(oldModel, newModel, aiAdapter, {
        useAIForInvariantEquivalence: !!aiAdapter,
      });
      const diffPath = writeReport(rootDir, 'diff/model-diff.json', result.diff);
      const impactPath = writeReport(rootDir, 'diff/impact-analysis.json', result.impact);
      console.log(formatDiffSummary(result));
      console.log(`\n差分报告: ${diffPath}`);
      console.log(`影响分析: ${impactPath}`);
      process.exit(0);
    } catch (err) {
      console.error(`错误：${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
  });

// ==========================================================================
// impact（影响分析：基于已有 diff 报告）
// ==========================================================================

program
  .command('impact')
  .description('影响分析：基于已有 diff 报告，推导受影响的下游步骤')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .action((opts) => {
    const rootDir = resolveCtx(opts).protocolRoot;
    try {
      const impact = readReport<import('../model/types.js').ImpactAnalysis>(
        rootDir,
        'diff/impact-analysis.json'
      );
      if (!impact) {
        console.error('未找到影响分析报告，请先运行 protochain diff');
        process.exit(2);
      }
      console.log('影响分析：');
      console.log(`  受影响步骤: ${impact.affectedSteps.join(', ') || '无'}`);
      console.log(`  受影响产物: ${impact.affectedArtifacts.length} 项`);
      impact.affectedArtifacts.forEach((a) => console.log(`    - ${a}`));
      console.log(`  建议增量重推导路径: ${impact.incrementalPlan.join(' → ') || '无'}`);
      console.log(`  分析时间: ${impact.analyzedAt}`);
      process.exit(0);
    } catch (err) {
      console.error(`错误：${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
  });

// ==========================================================================
// propagate（变更传播：生成清理计划与增量重推导路径）
// ==========================================================================

program
  .command('propagate')
  .description('变更传播：基于影响分析生成清理计划与增量重推导路径')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option('--clean', '清理已 stale 的产物文件')
  .action((opts) => {
    const rootDir = resolveCtx(opts).protocolRoot;
    try {
      const impact = readReport<import('../model/types.js').ImpactAnalysis>(
        rootDir,
        'diff/impact-analysis.json'
      );
      if (!impact) {
        console.error('未找到影响分析报告，请先运行 protochain diff');
        process.exit(2);
      }
      const result = propagate(impact, rootDir);
      writeReport(rootDir, 'diff/propagate-plan.json', result);
      console.log(formatPropagateSummary(result));
      if (opts.clean) {
        console.log('\n清理 stale 产物：');
        for (const artifact of result.staleArtifacts) {
          console.log(`  - ${artifact}（建议手动删除或重新运行对应步骤）`);
        }
      }
      process.exit(0);
    } catch (err) {
      console.error(`错误：${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
  });

// ==========================================================================
// version（版本管理）
// ==========================================================================

const versionCmd = program.command('version').description('版本管理（快照、列表、变更分类）');

versionCmd
  .command('save')
  .description('保存当前协议模型版本快照')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option('-f, --force', '覆盖已存在的版本快照')
  .action((opts) => {
    const ctx = resolveCtx(opts);
    const rootDir = ctx.protocolRoot;
    try {
      const model = parseProtocolFile(ctx.modelPath);
      const path = saveVersionSnapshot(model, rootDir, {
        force: opts.force,
        versionsDir: ctx.versionsDir,
      });
      console.log(`版本快照已保存：${path}`);
      console.log(`  版本: ${model.metadata.version}`);
      console.log(`  名称: ${model.metadata.name}`);
      process.exit(0);
    } catch (err) {
      console.error(`错误：${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
  });

versionCmd
  .command('list')
  .description('列出所有版本快照')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .action((opts) => {
    const ctx = resolveCtx(opts);
    const rootDir = ctx.protocolRoot;
    const versions = listVersions(rootDir, ctx.versionsDir);
    if (versions.length === 0) {
      console.log('暂无版本快照');
      process.exit(0);
    }
    console.log('版本快照列表：');
    for (const v of versions) {
      console.log(`  - v${v.version}: ${v.name}（${v.savedAt}）`);
    }
    process.exit(0);
  });

versionCmd
  .command('show <版本号>')
  .description('查看指定版本快照的元数据')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .action((version: string, opts: { dir: string }) => {
    const ctx = resolveCtx(opts);
    const rootDir = ctx.protocolRoot;
    const model = loadVersion(rootDir, version, ctx.versionsDir);
    if (!model) {
      console.error(`版本 ${version} 不存在`);
      process.exit(2);
    }
    console.log(`版本: ${model.metadata.version}`);
    console.log(`名称: ${model.metadata.name}`);
    console.log(`目的: ${model.metadata.purpose}`);
    console.log(`角色:`);
    for (const r of model.metadata.roles) {
      console.log(`  - ${r.id}: ${r.name}`);
    }
    console.log(`状态数: ${model.derivable.states.length}`);
    console.log(`转移数: ${model.derivable.transitions.length}`);
    console.log(`不变量数: ${model.derivable.invariants.length}`);
    process.exit(0);
  });

versionCmd
  .command('classify')
  .description('变更分类：基于已有 diff 报告，结合自动规则+AI辅助+使用方声明')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option('--no-ai', '禁用 AI 辅助不变量语义判断')
  .action(async (opts) => {
    const ctx = resolveCtx(opts);
    const rootDir = ctx.protocolRoot;
    const config = loadConfig(rootDir);
    let aiAdapter: AIAdapter | undefined = undefined;
    if (opts.ai && config.ai) {
      try {
        aiAdapter = createAIRouter(config.ai).get('semantic');
      } catch (err) {
        console.warn(`AI 适配器初始化失败：${err instanceof Error ? err.message : err}`);
      }
    }
    try {
      const diff = readReport<import('../model/types.js').ModelDiff>(
        rootDir,
        'diff/model-diff.json'
      );
      if (!diff) {
        console.error('未找到差分报告，请先运行 protochain diff');
        process.exit(2);
      }
      // 加载新旧模型（从 versions 或当前 model.md）
      const oldModel = parseProtocolFile(ctx.modelPath);
      const versions = listVersions(rootDir, ctx.versionsDir);
      if (versions.length === 0) {
        console.error('未找到版本快照，请先运行 protochain version save');
        process.exit(2);
      }
      const newModel = loadVersion(rootDir, versions[versions.length - 1].version, ctx.versionsDir)!;

      const result = await classifyChange(diff, oldModel, newModel, aiAdapter, {
        useAIForInvariantClassification: !!aiAdapter,
      });
      writeReport(rootDir, 'diff/classification.json', result.classification);

      // 将待确认项加入 ConfirmationTracker
      const tracker = createConfirmationTracker();
      for (const item of result.pendingConfirmations) {
        tracker.addPending(item);
      }
      writeReport(rootDir, 'diff/pending-confirmations.json', tracker.getPending());

      console.log(formatClassificationSummary(result));
      process.exit(0);
    } catch (err) {
      console.error(`错误：${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
  });

// ==========================================================================
// 辅助函数
// ==========================================================================

/** 解析项目上下文：--dir 为系统根，--protocol 指定多协议子协议 */
function resolveCtx(
  opts: { dir?: string },
  role: ContextRole = 'protocol'
): ProjectContext {
  return resolveProjectContext(opts.dir ?? process.cwd(), {
    protocol: program.opts().protocol,
    role,
  });
}

/**
 * 解析 CLI 路径选项（E3-I2 修复）：相对路径统一相对 rootDir 解析，
 * 绝对路径按原语义处理。
 *
 * 背景：先前 `--skeleton` / `--specs` / `-o` / `--report` 用 `resolve(opts.*)` 相对 cwd，
 * 而默认路径相对 `--dir`。`--dir` 与 cwd 不一致时落点错位。
 */
function resolveRelative(p: string, rootDir: string): string {
  if (pathIsAbsolute(p)) return p;
  return resolve(rootDir, p);
}

function registerStepExecutors(rootDir: string, useAi: boolean, protocolId?: string, envName?: string): void {
  const config = loadConfig(rootDir);
  let router: import('../ai/router.js').AIRouter | undefined = undefined;
  if (useAi && config.ai) {
    try {
      router = createAIRouter(config.ai);
    } catch (err) {
      console.warn(
        `AI 适配器初始化失败：${err instanceof Error ? err.message : err}`
      );
    }
  }
  // 多模型路由：语义层检查用便宜模型，reason/formalize/derive-contracts 用强模型，
  // 生成类步骤用 generation 模型（与 §7.2 分层一致）。
  const semanticAdapter = router?.get('semantic');
  const reasoningAdapter = router?.get('reasoning');
  const generationAdapter = router?.get('generation');
  registerExecutor('check', createCheckExecutor(semanticAdapter));
  registerExecutor('reason', createReasonExecutor(reasoningAdapter));
  registerExecutor('formalize', createFormalizeExecutor(reasoningAdapter, config));
  registerExecutor('derive-specs', createSpecifyExecutor());
  registerExecutor('derive-contracts', createContractExecutor(reasoningAdapter));
  registerExecutor('generate-tests', createTestGenExecutor(generationAdapter, config));
  registerExecutor('generate-cases', createCaseGenExecutor(config, generationAdapter));
  registerExecutor('check-impl', createImplCheckExecutor());
  registerExecutor('verify', createVerifyExecutor(semanticAdapter, config, protocolId, envName));
}

function createInteractiveCheckpointHandler() {
  return async (stepId: StepId, reportSummary: string): Promise<CheckpointDecision> => {
    const step = presentCheckpoint({
      step: { id: stepId } as never,
      result: { stepId, passed: true, executedAt: new Date().toISOString() },
      reportSummary,
    });
    console.log(step);

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<CheckpointDecision>((resolve) => {
      const ask = () => {
        rl.question('决策 > ', (answer) => {
          const trimmed = answer.trim();
          const [cmd, ...rest] = trimmed.split(/\s+/);
          const arg = rest.join(' ');
          if (cmd === 'approve' || cmd === 'a') {
            rl.close();
            resolve({ kind: 'approve', note: arg || undefined });
          } else if (cmd === 'reject' || cmd === 'r') {
            if (!arg) {
              console.log('reject 需要提供理由');
              ask();
              return;
            }
            rl.close();
            resolve({ kind: 'reject', reason: arg });
          } else if (cmd === 'skip' || cmd === 's') {
            rl.close();
            resolve({ kind: 'skip', note: arg || undefined });
          } else {
            console.log('请输入 approve / reject <reason> / skip');
            ask();
          }
        });
      };
      ask();
    });
  };
}

function printCheckReport(report: ReturnType<typeof checkCompleteness>): void {
  const m = report.mechanical;
  console.log('═══ ① 完备性检查报告 ═══');
  console.log(`机械层：${m.passed ? '✓ 通过' : '✗ 未通过'}`);
  printIssues('结构完备性', m.structuralIssues);
  printIssues('字段完整性', m.fieldIssues);
  printIssues('ID交叉引用', m.referenceIssues);

  if (report.semantic.executed) {
    const s = report.semantic;
    console.log(`\n语义层：${s.passed ? '✓ 通过' : '✗ 未通过'}（AI 已执行）`);
    printIssues('语义重复', s.duplicationIssues);
    printIssues('表达式歧义', s.ambiguityIssues);
    printIssues('独立语义判断', s.semanticIssues);
  } else {
    console.log('\n语义层：未执行（未配置 AI 适配器）');
  }

  console.log(`\n总体：${report.passed ? '✓ 通过' : '✗ 未通过'}`);
}

function printIssues(category: string, issues: { severity: string; message: string; elementId?: string }[]): void {
  if (issues.length === 0) {
    console.log(`  ${category}: 无问题`);
    return;
  }
  console.log(`  ${category}: ${issues.length} 项`);
  for (const issue of issues) {
    const tag = issue.severity === 'error' ? '[ERROR]' : issue.severity === 'warning' ? '[WARN]' : '[INFO]';
    const elem = issue.elementId ? ` <${issue.elementId}>` : '';
    console.log(`    ${tag}${elem} ${issue.message}`);
  }
}


// ==========================================================================
// m-check（M 单元语义闸门）
// ==========================================================================

program
  .command('m-check')
  .description('M 单元语义闸门：命名规范 / 跨协议 ID 唯一性 / 附属实体归属 / 旧字符 / ID 转义（修改单 002）')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option('--model <路径>', 'model.md 路径（默认 <dir>/protocol/model.md）')
  .option('--json', '以 JSON 形式输出（默认人类可读报告）')
  .action((opts) => {
    const rootDir = resolve(opts.dir);
    try {
      const report = mCheckCli({
        dir: rootDir,
        modelPath: opts.model,
      });
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatMCheckReport(report));
      }
      process.exit(report.passed ? 0 : 1);
    } catch (err) {
      console.error(
        `错误：${err instanceof Error ? err.message : err}`
      );
      process.exit(2);
    }
  });

// ==========================================================================
// derive-bindings（E3：binding 骨架自动生成）
// ==========================================================================

program
  .command('derive-bindings')
  .description('E3：从 specs.json (E2 产出) 机械推导 bindings.skeleton.yaml（method/path/params + baseUrl 占位）')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option('--specs <路径>', 'specs.json 路径（默认 <dir>/derived/specs.json）')
  .option('-o, --output <路径>', '骨架输出路径（默认 <dir>/derived/bindings.skeleton.yaml）')
  .option('--report <路径>', '生成率报告路径（默认 <dir>/derived/bindings-generation-report.json）')
  .option('-f, --force', '覆盖已存在骨架')
  .option('--silent-migration', '静默老格式 specs.json 迁移报警（默认打印到 stderr）')
  .action(async (opts) => {
    const ctx = resolveCtx(opts);
    const rootDir = ctx.protocolRoot;
    try {
      const result = await deriveBindings(
        {
          rootDir,
          // E3-I2 修复：相对路径参数统一相对 rootDir 解析（与默认路径一致）
          specsPath: opts.specs ? resolveRelative(opts.specs, rootDir) : undefined,
          outputPath: opts.output ? resolveRelative(opts.output, rootDir) : undefined,
          reportPath: opts.report ? resolveRelative(opts.report, rootDir) : undefined,
          force: opts.force,
          silentMigration: opts.silentMigration,
        },
        (rd) => parseProtocolFile(join(rd, 'protocol/model.md'))
      );

      const s = result.skeleton;
      console.log('=== E3 binding 骨架生成报告 ===');
      console.log(`  源 model.md version: ${s.sourceModelVersion}`);
      console.log(`  源 specs.json: ${s.sourceEnvelope ? 'Envelope' : '裸数组（已迁移）'}`);
      if (s.sourceMigrated) {
        console.log(`  ⚠ 老格式 specs.json 自动迁移完成（见 ${result.skeletonPath} 顶部 sourceMigrationWarnings）`);
      }
      console.log(`  接口总数: ${s.stats.total}（系统 ${s.stats.system} + 观测 ${s.stats.observation}）`);
      console.log(`  完整生成: ${s.stats.generated} / ${s.stats.total} = ${(s.stats.generationRate * 100).toFixed(1)}%`);
      console.log(`  部分生成: ${s.stats.partial}`);
      console.log(`  待人工确认项: ${s.stats.manualConfirmItems}（baseUrl × ${Object.keys(s.roles).length} + stateMap × ${Object.keys(s.stateMap ?? {}).length}）`);
      console.log(`\n  骨架产物: ${result.skeletonPath}`);
      console.log(`  生成报告: ${result.reportPath}`);
      console.log('\n下一步：在骨架上编辑 baseUrl / headers / authConfig / stateMap，然后运行 protochain bind --skeleton <path>');
      if (s.warnings.length > 0) {
        console.log('\n警告：');
        for (const w of s.warnings) console.log(`  - ${w}`);
      }
      // 验收口径：生成率 ≥ 80%
      process.exit(s.stats.generationRate >= 0.8 ? 0 : 1);
    } catch (err) {
      console.error(
        `错误：${err instanceof Error ? err.message : err}`
      );
      process.exit(2);
    }
  });

// ==========================================================================
// web（E7 P0：Web 检阅界面 — derive-web + serve）
// ==========================================================================

program
  .command('web')
  .description('E7 P0：Web 检阅界面（derive-web 机械生成静态站点 + web serve 起服务）')
  .argument('<subcommand>', '子命令：derive-web | serve');

// ----- web derive-web：100% 机械从 derived/*.json 生成 web/data.json + 静态站点 -----

program
  .command('derive-web')
  .description('E7 P0：机械生成 Web 检阅界面静态站点（web/data.json + VitePress dist/）')
  .option('-d, --dir <目录>', '项目根目录', process.cwd())
  .option('--data-json <路径>', 'web/data.json 输出路径（默认 <dir>/web/data.json）')
  .option('--web-dir <路径>', '站点工程目录（默认 <dir>/web）')
  .option('--dist-dir <路径>', 'VitePress 产物目录（默认 <webDir>/docs/.vitepress/dist）')
  .option('--no-build', '跳过 VitePress build（仅写 web/data.json + .md，便于调试）')
  .option('-f, --force', '覆盖已存在 web/ 产物')
  .action(async (opts) => {
    const rootDir = resolve(opts.dir);
    try {
      const result = await deriveWeb(
        {
          rootDir,
          dataJsonPath: opts.dataJson ? resolveRelative(opts.dataJson, rootDir) : undefined,
          webDir: opts.webDir ? resolveRelative(opts.webDir, rootDir) : undefined,
          distDir: opts.distDir ? resolveRelative(opts.distDir, rootDir) : undefined,
          buildSite: opts.build !== false,
          force: opts.force,
        },
        (rd) => parseProtocolFile(join(rd, 'protocol/model.md'))
      );

      const v = result.data;
      console.log('=== E7 P0 Web 检阅界面生成报告 ===');
      console.log(`  协议: ${v.protocol.name} (${v.protocol.version})`);
      console.log(`  web/data.json schemaVersion: ${v.schemaVersion} (=${WEB_DATA_SCHEMA_VERSION})`);
      console.log(`  源 model.md version: ${v.sourceModelVersion}`);
      console.log(`  接口总数: ${v.interfaces.length}（系统 ${v.interfaces.filter((i) => i.kind === 'system').length} + 观测 ${v.interfaces.filter((i) => i.kind === 'observation').length}）`);
      console.log(`  测试用例: ${v.testCases.length}`);
      console.log(`  验证报告: ${v.verification.hasReport ? `通过 ${v.verification.counts.passed} / 失败 ${v.verification.counts.failed}` : '未生成'}`);
      console.log(`  实现完整性: ${v.implCheck ? `通过 ${v.implCheck.passed ? '✓' : '✗'}（缺失 ${v.implCheck.missing}/${v.implCheck.total}）` : '未生成'}`);
      console.log(`  diff/impact: ${v.diff ? v.diff.summary : '未生成'}`);
      console.log(`\n  web/data.json: ${result.dataJsonPath}`);
      console.log(`  站点工程目录: ${result.webDir}`);
      console.log(`  VitePress dist: ${result.distDir}`);
      console.log(`  VitePress build: ${result.built ? '✓ 已生成 dist/index.html' : '✗ 未生成（见 warnings）'}`);
      console.log('\n  安全边界：不读 bindings.yaml / 不读 process.env / 不调 AI / 不接触令牌环境变量');
      console.log('  敏感字段脱敏: ' + SENSITIVE_FIELD_NAMES_REPORT);
      if (result.warnings.length > 0) {
        console.log('\n警告：');
        for (const w of result.warnings) console.log(`  - ${w}`);
      }
      // E7-I4 修复：四类页面落盘检查（去掉死代码 basicPages；exit 显式校验 5 类页面存在）
      const docsDir = join(result.webDir, 'docs');
      const requiredPages = [
        join(docsDir, 'index.md'),
        join(docsDir, 'interfaces/index.md'),
        join(docsDir, 'test-cases.md'),
        join(docsDir, 'verification.md'),
        join(docsDir, 'diff.md'),
      ];
      const missingPages = requiredPages.filter((p) => !existsSync(p));
      const hasDataJson = existsSync(result.dataJsonPath);
      const hasInterfacePages = v.interfaces.length > 0;
      if (!hasDataJson || !hasInterfacePages || missingPages.length > 0) {
        if (missingPages.length > 0) {
          console.error(
            `错误：缺以下页面（E7-I4 修复要求）:\n  - ${missingPages.join('\n  - ')}`
          );
        }
        process.exit(1);
      }
      process.exit(0);
    } catch (err) {
      console.error(`错误：${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
  });

/** CLI 提示：敏感字段名清单（避免硬编码在多处；与 src/webgen/index.ts 的 SENSITIVE_FIELD_NAMES 对齐） */
const SENSITIVE_FIELD_NAMES_REPORT = 'tokenEnv/secretEnv/passwordEnv/keyEnv/usernameEnv/certPath/keyPath/caPath/token/secret/password/apiKey';

// ----- web serve：纯 stdlib http 静态服务（不读 process.env） -----

program
  .command('web-serve')
  .description('E7 P0：起 web 检阅界面静态服务（基于 web/.vitepress/dist/；纯 stdlib http）')
  .option('-d, --dir <目录>', '项目根目录（默认 cwd）', process.cwd())
  .option('--dist-dir <路径>', 'VitePress dist 目录（默认 <dir>/web/docs/.vitepress/dist；与 derive-web outDir 一致）')
  .option('-p, --port <端口>', '监听端口', '5173')
  .option('-H, --host <host>', '监听 host', '127.0.0.1')
  .option('--skip-probe', '跳过启动时 4 类 URL 探针（默认探针）')
  .action(async (opts) => {
    const rootDir = resolve(opts.dir);
    // E7-I1 修复：默认 distDir 与 derive-web outDir 对齐 = web/docs/.vitepress/dist
    const distDir = opts.distDir ? resolveRelative(opts.distDir, rootDir) : join(rootDir, 'web/docs/.vitepress/dist');
    try {
      // E7-I2 修复：从 web/data.json 读真实接口 ID 构造探针路径（不再硬编码 IF_SYS_T1）
      let probePaths: string[] | undefined = undefined;
      if (!opts.skipProbe) {
        const dataJsonPath = join(rootDir, 'web/data.json');
        const probeBase = ['/', '/interfaces/', '/test-cases', '/verification', '/diff'];
        if (existsSync(dataJsonPath)) {
          try {
            const dataRaw = JSON.parse(readFileSync(dataJsonPath, 'utf-8')) as {
              interfaces?: Array<{ id: string }>;
            };
            const firstInterfaceId = dataRaw.interfaces?.[0]?.id;
            if (firstInterfaceId) {
              probePaths = [...probeBase, `/interfaces/${firstInterfaceId}`];
            } else {
              probePaths = probeBase;
            }
          } catch {
            probePaths = probeBase;
          }
        } else {
          probePaths = probeBase;
        }
      }
      const handle = await startServe({
        distDir,
        port: Number(opts.port),
        host: opts.host,
        probePaths,
      });
      console.log('=== E7 P0 web serve ===');
      console.log(`  监听: http://${handle.address.host}:${handle.address.port}`);
      console.log(`  站点根: ${distDir}`);
      console.log(`  安全：不读 process.env / 不读 bindings.yaml / 不调 AI`);
      console.log('\n四类页面已探针（全部 200）：');
      console.log('  - /                            (首页)');
      console.log('  - /interfaces/                 (接口列表)');
      console.log('  - /interfaces/<id>             (接口详情，按 specs 实际接口 ID)');
      console.log('  - /test-cases                  (测试用例浏览器)');
      console.log('  - /verification                (双跑对比)');
      console.log('  - /diff                        (模型 diff/impact)');
      console.log('\n按 Ctrl+C 退出');
      // 优雅退出
      const shutdown = async () => {
        console.log('\n关闭 web serve...');
        await handle.close();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      // 保持进程：等待关闭信号
      await new Promise(() => {});
    } catch (err) {
      console.error(`错误：${err instanceof Error ? err.message : err}`);
      process.exit(2);
    }
  });

// ==========================================================================
// init-runner（初始化协议建模工程 + protocol-runner 编排实例）
// ==========================================================================

program
  .command('init-runner')
  .description('初始化协议建模工程 + protocol-runner 编排实例（协议建模驱动开发完整起步）')
  .requiredOption('-s, --system <系统名>', '系统名称')
  .requiredOption('-p, --protocols <列表>', '子协议列表，格式 P1:名称1,P2:名称2')
  .option('--modeling-dir <目录>', '建模目录（相对项目根）', 'modeling')
  .option('--impl-dir <目录>', '实现目录（相对项目根）', 'impl')
  .option('--instance-dir <目录>', '编排实例目录（相对项目根）', 'protocol-runner')
  .option('-d, --dir <目录>', '目标根目录', process.cwd())
  .option('-f, --force', '覆盖已存在的实例')
  .action((opts) => {
    const rootDir = resolve(opts.dir);
    const protocols = opts.protocols.split(',').map((s: string) => {
      const [pid, ...nameParts] = s.trim().split(':');
      const name = nameParts.join(':').trim() || pid.trim();
      return { protocolId: pid.trim(), name };
    });
    const result = initRunnerProject({
      systemName: opts.system,
      rootDir,
      protocols,
      modelingDir: opts.modelingDir,
      implDir: opts.implDir,
      instanceDir: opts.instanceDir,
      force: opts.force,
      templateDir: fileURLToPath(new URL('../../templates/protocol-runner-instance', import.meta.url)),
    });
    console.log(`协议建模工程 + protocol-runner 实例 "${opts.system}" 已初始化于 ${rootDir}`);
    console.log('建模骨架目录:');
    for (const d of result.modeling.createdDirs) console.log(`  + ${opts.modelingDir}/${d}/`);
    console.log('实例目录:');
    for (const d of result.createdDirs) console.log(`  + ${d}/`);
    for (const f of result.createdFiles) console.log(`  + ${f}`);
    console.log('\n下一步：');
    console.log(`  1. 在 ${opts.instanceDir}/env/dev.env 填写剩余占位符（如 {{API_KEY}}，位于 scripts/init-modeling.mjs 生成的 config 中）`);
    console.log(`  2. 输入第一个需求，运行：protocol-runner --project ${rootDir}/${opts.instanceDir}`);
  });

program.parse();
