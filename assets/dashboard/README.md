# LoongSuite Pilot Dashboard

The local dashboard starts and stops with the collector. Open:

```text
http://127.0.0.1:8765/
```

The HTTP server exposes only:

- `GET /` - this static page.
- `GET /metrics-summary.json` - the unmodified `logs/metrics-summary.json` file.

The page reads collector-generated summaries without parsing raw event logs. Agent cards are created
dynamically from `ranges.today.agentShares`, so newly supported agent types do
not require a dashboard code change.

The **AI File Line Changes · By Agent** table sums daily entries from
`codeChangeHistory.days` for the selected inclusive start/end dates. The
collector supplies the available bounds in `startDate` and `endDate`: its current
date and the preceding 200 days. This filter does not change the token widgets.
Refreshes and language changes preserve the selected range. An older collector
without this history shows an upgrade prompt instead of substituting today's data.

Line counts require successful edit evidence. Unsupported operations and older
logs without diffs remain unmeasured; a dash does not mean zero output. See the
[line-change guide (Chinese)](../../docs/zh-CN/code-line-metrics.md) for supported
tools, counting rules, and deployment requirements.

On the first visit, the page selects Simplified Chinese when the browser's
preferred language starts with `zh`; otherwise it uses English. The language
selector in the header applies immediately to labels, states, errors,
accessibility text, numbers, dates, and times. The choice is saved in
`localStorage` when available; the dashboard continues to work when browser
storage is blocked.

The server binds to `127.0.0.1` on `dashboard.port` (default `8765`) and does not open the system browser.
