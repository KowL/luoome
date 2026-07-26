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

  const consumeLine = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === '[DONE]') return;
    onPart(JSON.parse(payload));
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) consumeLine(line);
    if (done) break;
  }
  if (buffer.length > 0) consumeLine(buffer);
};
