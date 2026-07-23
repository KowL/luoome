import { vi } from 'vitest';

export interface MockResponse {
  status: number;
  body: unknown;
}

export function mockFetch(responses: MockResponse[]) {
  const queue = [...responses];
  return vi.fn(async () => {
    const response = queue.shift();
    if (!response) throw new Error('Unexpected fetch call');
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as ReturnType<typeof vi.fn<typeof fetch>>;
}
