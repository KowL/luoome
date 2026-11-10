import type { Tool } from '@luoome/tools';
import * as tools from '@luoome/tools';

/**
 * App Service 直执行表（S4.1b）：34 个 Agent Tool 之外的旧 tool 不再经 toolRegistry，
 * 由 Web/CLI 消费面直接按名取对象执行（S4.1c 摘除 registry 注册后仍可用）。
 * 仅做名字 → 导出 tool 对象索引，不含 registry 语义。
 */
const byName = new Map<string, Tool>();
for (const value of Object.values(tools)) {
  if (typeof value !== 'object' || value === null) continue;
  if (!('name' in value) || !('execute' in value)) continue;
  const tool = value as Tool;
  if (typeof tool.name === 'string' && typeof tool.execute === 'function') {
    byName.set(tool.name, tool);
  }
}

export const appServiceTool = (name: string): Tool | undefined => byName.get(name);
