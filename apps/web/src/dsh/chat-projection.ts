import { CHAT_MESSAGE_PARTS_MAX } from '@luoome/core';

export type UIStreamPart = Record<string, unknown>;
interface ProjectedText {
  id: string;
  part: UIStreamPart;
  text: string;
  filter: VisibleText;
  durable: boolean;
  ended: boolean;
}

const visibleMessage = (text: string): string =>
  text.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '');
const suffixLength = (value: string, marker: string) => {
  for (let size = Math.min(value.length, marker.length - 1); size > 0; size--)
    if (marker.startsWith(value.slice(-size))) return size;
  return 0;
};

class VisibleText {
  #buffer = '';
  #thinking = false;

  push(delta: string, final = false): string {
    this.#buffer += delta;
    let output = '';
    while (this.#buffer.length > 0) {
      const marker = this.#thinking ? '</think>' : '<think>';
      const at = this.#buffer.indexOf(marker);
      if (at >= 0) {
        if (!this.#thinking) output += this.#buffer.slice(0, at);
        this.#buffer = this.#buffer.slice(at + marker.length);
        this.#thinking = !this.#thinking;
        continue;
      }
      const held = final ? 0 : suffixLength(this.#buffer, marker);
      if (!this.#thinking) output += held === 0 ? this.#buffer : this.#buffer.slice(0, -held);
      this.#buffer = held === 0 ? '' : this.#buffer.slice(-held);
      break;
    }
    return output;
  }
}

/** Product projection only; transport identity and payload validation stay in the event adapter. */
export class DshChatProjection {
  readonly #parts: UIStreamPart[] = [];
  readonly #texts = new Map<string, ProjectedText>();
  readonly #tools = new Map<string, UIStreamPart>();
  #bytes = 0;

  constructor(
    readonly messageId: string,
    private readonly emit: (part: UIStreamPart) => void,
    private readonly allowedTools: ReadonlySet<string>,
  ) {
    emit({ type: 'start', messageId });
    emit({ type: 'start-step' });
  }

  get parts(): readonly UIStreamPart[] {
    return this.#parts;
  }

  textDelta(identity: string, delta: string): void {
    const text = this.#text(identity);
    if (text.durable || text.ended) return;
    this.#append(text, text.filter.push(delta));
  }

  durableText(identity: string, content: string): void {
    const text = this.#text(identity);
    const authoritative = visibleMessage(content);
    if (text.durable) {
      if (text.text !== authoritative) throw new Error('DSH conflicting durable text');
      return;
    }
    this.#append(text, text.filter.push('', true));
    if (!authoritative.startsWith(text.text)) throw new Error('DSH text reconciliation failed');
    this.#append(text, authoritative.slice(text.text.length));
    text.durable = true;
    this.#end(text);
  }

  toolCall(callId: string, toolName: string, input: unknown): void {
    if (!this.allowedTools.has(toolName)) throw new Error('DSH unbound tool event');
    const previous = this.#tools.get(callId);
    if (previous !== undefined) {
      if (
        previous.type !== `tool-${toolName}` ||
        JSON.stringify(previous.input) !== JSON.stringify(input)
      )
        throw new Error('DSH conflicting tool call');
      return;
    }
    this.#reserve();
    this.#count(JSON.stringify(input));
    const part = { type: `tool-${toolName}`, toolCallId: callId, state: 'input-available', input };
    this.#tools.set(callId, part);
    this.#parts.push(part);
    this.emit({ type: 'tool-input-available', toolCallId: callId, toolName, input });
  }

  toolResult(callId: string, ok: boolean, output: unknown): void {
    const part = this.#tools.get(callId);
    if (part === undefined) throw new Error('DSH result without bound call');
    if (part.state === 'output-available' || part.state === 'output-error') {
      if (JSON.stringify(part.output) !== JSON.stringify(output))
        throw new Error('DSH conflicting tool result');
      return;
    }
    this.#count(JSON.stringify(output));
    const businessError = output !== null && typeof output === 'object' && 'error' in output;
    if (ok || businessError) {
      Object.assign(part, { state: 'output-available', output });
      this.emit({ type: 'tool-output-available', toolCallId: callId, output });
    } else {
      const errorText = '工具未完成，请核对实际结果。';
      Object.assign(part, { state: 'output-error', output, errorText });
      this.emit({ type: 'tool-output-error', toolCallId: callId, errorText });
    }
  }

  data(type: string, data: unknown): void {
    if (this.#parts.length >= CHAT_MESSAGE_PARTS_MAX)
      throw new Error('DSH chat part limit exceeded');
    const part = { type, data };
    this.#count(JSON.stringify(part), 532_480);
    this.#parts.push(part);
    this.emit(part);
  }

  end(): void {
    this.#closeTexts();
  }

  #text(identity: string) {
    const existing = this.#texts.get(identity);
    if (existing !== undefined) return existing;
    this.#reserve();
    const id = `text-${this.#texts.size}`;
    const part: UIStreamPart = { type: 'text', text: '' };
    const value = { id, part, text: '', filter: new VisibleText(), durable: false, ended: false };
    this.#texts.set(identity, value);
    this.#parts.push(part);
    this.emit({ type: 'text-start', id });
    return value;
  }

  #append(text: ProjectedText, delta: string): void {
    if (delta.length === 0) return;
    this.#count(delta);
    text.text += delta;
    text.part.text = text.text;
    this.emit({ type: 'text-delta', id: text.id, delta });
  }

  #end(text: { id: string; ended: boolean }): void {
    if (text.ended) return;
    text.ended = true;
    this.emit({ type: 'text-end', id: text.id });
  }

  #closeTexts(): void {
    for (const text of this.#texts.values()) {
      if (!text.ended) this.#append(text, text.filter.push('', true));
      this.#end(text);
    }
  }

  #reserve(): void {
    if (this.#parts.length >= CHAT_MESSAGE_PARTS_MAX - 5)
      throw new Error('DSH chat part limit exceeded');
  }

  #count(value: string, limit = 524_288): void {
    const bytes = this.#bytes + Buffer.byteLength(value);
    if (bytes > limit) throw new Error('DSH chat output limit exceeded');
    this.#bytes = bytes;
  }
}
