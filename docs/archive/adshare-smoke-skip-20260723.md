# Adshare integration smoke test — skipped

Date: 2026-07-23
Branch: `feature/adshare-sdk-integration`

## Decision

The real remote smoke test was intentionally skipped by the owner. This run did **not** access `8.148.216.30:8888` and did not bypass the Hermes security gate for cleartext HTTP requests to a raw IP address.

## Existing mock fallback verification

The result below is carried forward from completed task `t_c45a3486`:

- The luoome web server started successfully on port `5173` with `bun --cwd apps/web src/index.ts`.
- With Adshare configuration missing or the upstream URL made unreachable, the route logged an Adshare failure and fell back to the local mock market adapter backed by the existing `MOCK_STOCKS` dataset.
- `GET /api/stocks/search?q=贵州茅台` returned HTTP `200`.
- The first matching stock was:
  - `id`: `600519.SH`
  - `code`: `600519`
  - `exchange`: `SH`
  - `name`: `贵州茅台`
- The response retained the expected `{ data: { stocks, total, source } }` contract.
- The scoped web test suite passed: `12` tests.

Note: the fallback response reports `source: "market"` because the local mock market adapter performs the lookup; it does not indicate that the remote Adshare service was reached.

## Why the real smoke test was skipped

1. The remote Adshare service currently returns empty stock-name fields; the Adshare T6 fix has not yet been deployed. A live search by name would therefore not provide a meaningful end-to-end validation.
2. Accessing `http://8.148.216.30:8888` uses cleartext HTTP with a raw IP and triggered the Hermes security gate.
3. The owner explicitly chose to keep the gate enabled and not bypass it for this test.

Accordingly, this report does not claim real remote measurements for HTTP status, latency, or hit count.

## Follow-up after Adshare T6 deployment

After the T6 fix is deployed and the remote `stock_basic` response contains populated `name` values:

1. Start luoome web with project-local `.env` values pointing `ADSHARE_URL` to the production Adshare service and configure the project-local API key.
2. Confirm from application logs or equivalent instrumentation that the request is forwarded to the production Adshare service rather than the mock adapter.
3. Run:

   ```sh
   curl --get \
     --data-urlencode 'q=贵州茅台' \
     --output /tmp/luoome-adshare-smoke.json \
     --write-out 'http_code=%{http_code}\ntime_total=%{time_total}\n' \
     http://localhost:5173/api/stocks/search
   ```

4. Parse `data.stocks.length` (or the current equivalent response field), convert `time_total` to whole milliseconds, and record the observed HTTP status, latency, and hit count in a new deployment log.
5. Verify the returned result includes `600519.SH` with the non-empty name `贵州茅台`.
