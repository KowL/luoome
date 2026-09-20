// 在隔离测试服务器的 #dashboard 页面中 evaluate 本文件；返回检查结果，不写业务数据。
(async () => {
  const { renderDashboard, invalidateDashboard } = await import('/js/pages.js');
  const q = (selector) => document.querySelector(selector);
  const originalFetch = window.fetch;
  const scope = q('#dashboard-board-scope');
  const originalScope = scope.value;
  const checks = [];
  const assert = (condition, name) => {
    if (!condition) throw new Error(name);
    checks.push(name);
  };
  const changeScope = async (value) => {
    scope.value = value;
    scope.dispatchEvent(new Event('change', { bubbles: true }));
    await renderDashboard(() => {});
  };
  const unavailable = () => Response.json({ ok: false, error: { kind: 'adapter_error' } });
  let mode = 'live';
  let release;
  try {
    window.fetch = async (path, options) => {
      if (typeof path !== 'string' || !path.startsWith('/api/dashboard?'))
        return originalFetch(path, options);
      if (mode === 'failure') return unavailable();
      if (mode === 'delayed')
        return new Promise((resolve) => {
          release = resolve;
        });
      const response = await originalFetch(path, options);
      if (mode !== 'sections') return response;
      const body = await response.json();
      body.data.advice = null;
      body.data.watch = null;
      body.data.alertPlans = null;
      body.data.watchlists = null;
      body.data.staleWatchlistCount = null;
      body.data.boardCoverage.complete = false;
      body.data.todayTriggerCoverage.available = false;
      body.data.todayTriggerCoverage.total = null;
      body.data.todayTriggers = [];
      body.data.metrics.latestRun = null;
      return Response.json(body);
    };
    await changeScope('all');
    const before = q('#dashboard-board').textContent;
    mode = 'failure';
    await renderDashboard(() => {});
    assert(q('#dashboard-board').textContent === before, '同范围刷新失败保留看板');
    await changeScope('holdings');
    assert(!q('#dashboard-board').textContent.includes('正在加载'), '筛选失败不残留加载占位');
    assert(q('#dashboard-board').textContent.includes('加载失败'), '筛选失败明确提示');
    assert(
      !q('#dashboard-warnings').textContent.includes('保留最后成功结果'),
      '不声称保留已清除的结果',
    );
    const retry = q('#dashboard-board button');
    assert(retry?.textContent === '重试', '失败范围提供重试入口');
    mode = 'live';
    retry.click();
    await renderDashboard(() => {});
    assert(scope.value === 'holdings' && q('.board-table') !== null, '重试恢复并保留所选范围');
    mode = 'sections';
    await renderDashboard(() => {});
    assert(q('.board-table') !== null, '其它区块失败时看板继续展示');
    assert(q('#dash-advice-list').textContent.includes('读取失败'), '建议失败不显示暂无建议');
    assert(q('#dash-watch-state').textContent.includes('读取失败'), '盯盘状态失败不显示未运行');
    assert(
      q('#dash-alert-count').textContent === '--' && q('#dash-stale-count').textContent === '--',
      '失败计数保持未知',
    );
    assert(q('#dash-trigger-list').textContent.includes('暂不可用'), '预警失败不显示零次触发');
    mode = 'live';
    await renderDashboard(() => {});
    assert(!q('#dash-advice-list').textContent.includes('读取失败'), '故障解除后区块恢复');
    mode = 'delayed';
    const stale = renderDashboard(() => {});
    mode = 'live';
    await changeScope('all');
    const current = q('#dashboard-board').textContent;
    release(unavailable());
    await stale;
    assert(q('#dashboard-board').textContent === current, '旧范围迟到失败不覆盖新范围');
    return JSON.stringify(checks);
  } finally {
    release?.(unavailable());
    window.fetch = originalFetch;
    invalidateDashboard();
    await changeScope(originalScope);
  }
})();
