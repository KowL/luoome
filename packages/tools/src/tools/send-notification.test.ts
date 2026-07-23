import { describe, expect, it } from 'vitest';
import { buildTestContext } from '../testing/context.js';
import { sendNotificationTool } from './send-notification.js';

describe('tool/send_notification', () => {
  it('channel=feishu 但没配 feishu payload → invalid_input', async () => {
    const ctx = await buildTestContext();
    const r = await sendNotificationTool.execute({ channel: 'feishu' }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('invalid_input');
  });

  it('channel=log → 通知成功落库', async () => {
    const ctx = await buildTestContext();
    const r = await sendNotificationTool.execute(
      { channel: 'log', log: { title: 't', content: 'c', level: 'info' } },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.notification.channel).toBe('log');
    expect(r.data.notification.result).toBe('success');
  });

  it('channel 缺省 = log', async () => {
    const ctx = await buildTestContext();
    const r = await sendNotificationTool.execute({ log: { title: 't', content: 'c' } }, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.notification.channel).toBe('log');
  });
});
