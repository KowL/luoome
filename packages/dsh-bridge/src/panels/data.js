import { useCallback, useEffect, useMemo, useState } from 'react';

/** 从聚合结果里取工具结果；`data` 只在 ok 时存在，失败用 `errorOf` 展示。 */
export const resultOf = (results, tool) => results?.[tool] ?? null;
export const dataOf = (results, tool) => {
  const result = results?.[tool];
  return result && result.ok === true ? result.data : null;
};
export const errorOf = (results, tool) => {
  const result = results?.[tool];
  return result && result.ok !== true ? (result.error ?? { message: '读取失败' }) : null;
};

const fetchPanel = async (panel, signal) => {
  const response = await fetch(`api/luoome.panels/${panel}`, {
    signal,
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  const results = {};
  for (const item of body?.results ?? []) {
    if (typeof item?.tool === 'string') results[item.tool] = item.result;
  }
  return results;
};

/**
 * 一次并发读取若干面板路由。
 *
 * 每条路由内部已经是并行工具调用；这里再按面板并发，是为了让「看盘」的本地事实
 * 不被 A 股情绪取数拖住——market 面板慢时，首屏照常先渲染持仓与触发。
 */
export function useFactPanels(panelKey) {
  const panels = useMemo(() => panelKey.split(',').filter(Boolean), [panelKey]);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState({
    loading: true,
    results: {},
    panelErrors: {},
    loadedAt: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setState((prev) => ({ ...prev, loading: true }));

    Promise.all(
      panels.map(async (panel) => {
        try {
          return { panel, results: await fetchPanel(panel, controller.signal) };
        } catch (error) {
          if (controller.signal.aborted) return null;
          return { panel, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    ).then((items) => {
      if (!alive) return;
      const results = {};
      const panelErrors = {};
      for (const item of items) {
        if (item === null) continue;
        if (item.error) panelErrors[item.panel] = item.error;
        Object.assign(results, item.results ?? {});
      }
      setState({ loading: false, results, panelErrors, loadedAt: new Date() });
    });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [panels, tick]);

  const refresh = useCallback(() => setTick((value) => value + 1), []);
  return { ...state, refresh };
}
