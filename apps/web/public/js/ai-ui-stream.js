const errorMessage = async (response) => {
  try {
    const body = await response.json();
    return body?.error?.message ?? body?.error?.cause ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
};

export const consumeUIMessageStream = async (response, onPart) => {
  if (!response.ok) throw new Error(await errorMessage(response));
  if (response.body === null) throw new Error('聊天响应没有可读取的数据流');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;

  const consumeLine = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === '[DONE]') return;
    const part = JSON.parse(payload);
    if (part.type === 'finish') finished = true;
    onPart(part);
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
      if (done) break;
    }
    if (buffer.length > 0) consumeLine(buffer);
    if (!finished) throw new Error('回复中途断开，请重试或重新打开会话检查已保存的内容');
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
};
