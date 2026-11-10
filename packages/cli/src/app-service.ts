import type { Tool } from '@luoome/tools';
import * as tools from '@luoome/tools';
import { toolRegistry } from '@luoome/tools';

/**
 * S4.1b：CLI 消费面在 34 个 Agent Tool 之外仍需要旧能力时，按 name 直接取
 * 导出的 tool 对象（App Service，不经 registry）；registry 命中优先。
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

export const resolveTool = (name: string): Tool | undefined =>
  toolRegistry.get(name) ?? byName.get(name);
