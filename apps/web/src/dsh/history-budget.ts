const MAX_PROMPT_CHARS = 180_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const jsonLength = (value: unknown): number => {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
};

const truncatedOutput = (originalCharacters: number) => ({
  truncated: true,
  note: '工具结果过长，已从本地上下文截断；完整结果仍保存在会话记录中。如缺少事实，请用更小的范围或过滤条件重新调用该工具。',
  originalCharacters,
});

export interface BoundedTrustedHistory {
  readonly history: readonly unknown[];
  readonly truncatedParts: number;
  readonly overflow: boolean;
}

/**
 * DSH 把历史序列化成 Host 的 `prompt`，协议上限为 256k 字符。历史里的工具结果
 * 没有上限，单条 list_watch_plans 就可能超过整个预算；这里按字符预算截断工具
 * 结果，保证同一会话可以继续，而不是每轮都在 Host 校验处失败。
 */
export const boundTrustedHistory = (history: readonly unknown[]): BoundedTrustedHistory => {
  const clone = history.map((message) => {
    if (!isRecord(message) || !Array.isArray(message.parts)) return message;
    return {
      ...message,
      parts: message.parts.map((part) => (isRecord(part) ? { ...part } : part)),
    };
  });

  const candidates: { message: number; part: number; size: number }[] = [];
  for (let messageIndex = 0; messageIndex < clone.length; messageIndex += 1) {
    const message = clone[messageIndex];
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (let partIndex = 0; partIndex < message.parts.length; partIndex += 1) {
      const part = message.parts[partIndex];
      if (!isRecord(part) || typeof part.type !== 'string' || !part.type.startsWith('tool-'))
        continue;
      if (!('output' in part)) continue;
      candidates.push({ message: messageIndex, part: partIndex, size: jsonLength(part.output) });
    }
  }

  let promptLength = jsonLength({ trustedHistory: clone });
  let truncatedParts = 0;
  candidates.sort((left, right) => right.size - left.size);
  for (const candidate of candidates) {
    if (promptLength <= MAX_PROMPT_CHARS) break;
    const message = clone[candidate.message];
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    const part = message.parts[candidate.part];
    if (!isRecord(part)) continue;
    const replacement = truncatedOutput(candidate.size);
    const reduction = candidate.size - jsonLength(replacement);
    if (reduction <= 0) continue;
    message.parts[candidate.part] = { ...part, output: replacement };
    promptLength -= reduction;
    truncatedParts += 1;
  }

  return {
    history: clone,
    truncatedParts,
    overflow: promptLength > MAX_PROMPT_CHARS,
  };
};
