#!/usr/bin/env bash
# =============================================================================
# Protochain T1 viewer 环境准备脚本（Windows Git Bash）
#
# 背景：当前 node_modules 处于不一致状态，且受两处环境干扰：
#   1) esbuild 原生二进制缺失（@esbuild/win32-x64 曾被删除，npm reify 时
#      copyfile EPERM / safe-delete(回收站) 超时导致重装中断）；
#   2) jsdom 依赖树含 ESM-only 包（@exodus/bytes），jest CJS 运行时无法
#      转换 node_modules ESM —— 已通过 tests/stubs/exodus-bytes.cjs 垫片解决
#      （jest moduleNameMapper 映射），无需 babel。
#
# 本脚本在【普通终端】执行（无沙箱限制），一次性把环境恢复到可用状态：
#   清理残留 → npm 全量重装 → 确认测试路径 junction → 重建 parser bundle → 校验
#
# 用法：
#   bash scripts/prepare-env.sh
#   bash scripts/prepare-env.sh --registry https://registry.npmmirror.com   # 换源
# =============================================================================

set -euo pipefail

# ---- 定位项目根（脚本所在目录的上一级） ----
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

REGISTRY="${1:-}"
NPM_REGISTRY_ARGS=()
if [ -n "$REGISTRY" ]; then
  NPM_REGISTRY_ARGS+=(--registry "$REGISTRY")
fi

echo "==> 项目根: $ROOT"
echo "==> 当前 registry: $(npm config get registry)"

# ---- 1. 停止可能占用 esbuild 二进制的 node 进程 ----
echo ""
echo "==> [1/6] 停止残留 node/esbuild 进程（避免文件锁）"
powershell.exe -NoProfile -Command \
  "Get-Process node,esbuild -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue" || true
sleep 1

# ---- 2. 清理 node_modules 残留（npm reify 中断留下的临时目录/点文件） ----
echo ""
echo "==> [2/6] 清理 node_modules 残留临时文件"
rm -rf node_modules/.esbuild-* 2>/dev/null || true
rm -f node_modules/.bin/.esbuild* 2>/dev/null || true
rm -f node_modules/.bin/.acorn* 2>/dev/null || true
echo "    清理完成"

# ---- 3. npm 全量重装依赖（普通终端无 EPERM/回收站超时；禁用 safe-delete 更稳） ----
echo ""
echo "==> [3/6] npm install（全量重装，重建 esbuild 二进制 + jsdom）"
npm install --no-audit --no-fund --safe-delete=false "${NPM_REGISTRY_ARGS[@]}"

echo ""
echo "==> 校验关键依赖"
node -e "const e=require('esbuild'); console.log('    esbuild:', e.version)"
node -e "console.log('    jsdom  :', require('./node_modules/jsdom/package.json').version)"
test -f node_modules/@esbuild/win32-x64/esbuild.exe && echo "    esbuild 二进制: OK" || { echo "    esbuild 二进制: 缺失！"; exit 1; }

# ---- 4. 确认测试路径 junction（tests 硬编码 /work/protochain/tests/fixtures） ----
echo ""
echo "==> [4/6] 确认 /work/protochain junction（测试 fixture 路径）"
if [ ! -d "/c/work/protochain" ]; then
  mkdir -p /c/work
  WIN_ROOT="$(cygpath -w "$ROOT" | sed 's/\\/\\\\/g')"
  powershell.exe -NoProfile -Command "New-Item -ItemType Junction -Path 'C:\work\protochain' -Target '$WIN_ROOT' -Force | Out-Null"
  echo "    junction 已创建: C:\\work\\protochain -> $ROOT"
else
  echo "    junction 已存在: C:\\work\\protochain"
fi
test -f /c/work/protochain/tests/fixtures/approval-flow.md && echo "    fixture 可达: OK" || { echo "    fixture 不可达: 失败"; exit 1; }

# ---- 5. 重建 parser bundle（TA2 产物，viewer 依赖） ----
echo ""
echo "==> [5/6] 重建 viewer/assets/parser.js"
npm run build:parser

# ---- 6. 校验：tsc + 关键测试 ----
echo ""
echo "==> [6/6] 校验：tsc --noEmit + T1 相关 jest"
npx tsc --noEmit && echo "    tsc: 0 errors"

npx jest \
  tests/webgen/viewer-data-contract.test.ts \
  tests/webgen/parser-bundle.test.ts \
  tests/webgen/viewer-n1-guard.test.ts \
  tests/webgen/viewer-smoke.test.ts 2>&1 | tail -6

echo ""
echo "================================================================"
echo " 环境准备完成。后续命令："
echo "   npx tsc --noEmit                        # 类型检查"
echo "   npx jest                                # 全量测试（Windows 环境有少量
echo "                                            #  端口/路径类失败属环境差异）"
echo "   npm run build:parser                    # 重建 viewer parser bundle"
echo "================================================================"
