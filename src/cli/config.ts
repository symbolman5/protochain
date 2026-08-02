/**
 * 配置文件读写
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ProtochainConfig } from '../model/types.js';
import { CONFIG_FILE, findConfigPath } from '../project/context.js';

/**
 * 读取配置：从 rootDir 向上查找 protochain.config.yaml（多协议子协议目录下
 * 也能读到系统根配置，见 BUGS.md BUG-002）。找不到返回默认配置。
 */
export function loadConfig(rootDir: string): ProtochainConfig {
  const configPath = findConfigPath(rootDir);
  if (!configPath) {
    return { name: 'unnamed' };
  }
  const raw = readFileSync(configPath, 'utf-8');
  return parseYaml(raw) as ProtochainConfig;
}

/** 写回配置：写入向上查找到的配置文件（保证 config set/get 读写同一文件） */
export function saveConfig(rootDir: string, config: ProtochainConfig): void {
  const configPath = findConfigPath(rootDir) ?? join(rootDir, CONFIG_FILE);
  writeFileSync(configPath, stringifyYaml(config), 'utf-8');
}

/** 按点分路径设置嵌套配置值，如 "ai.provider" */
export function setConfigValue(
  config: ProtochainConfig,
  key: string,
  value: string
): ProtochainConfig {
  const parts = key.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let target: any = config;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (target[part] === undefined || typeof target[part] !== 'object') {
      target[part] = {};
    }
    target = target[part];
  }
  const lastKey = parts[parts.length - 1];
  // 尝试解析为布尔/数字
  let parsed: string | number | boolean = value;
  if (value === 'true') parsed = true;
  else if (value === 'false') parsed = false;
  else if (/^-?\d+$/.test(value)) parsed = parseInt(value, 10);
  else if (/^-?\d+\.\d+$/.test(value)) parsed = parseFloat(value);
  target[lastKey] = parsed;
  return config;
}
