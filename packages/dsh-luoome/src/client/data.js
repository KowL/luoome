// dsh-luoome client 数据层：宿主认证只读路由 /api/luoome/state?panel=...
//
// 浏览器只做两件事：fetch 同源 no-store 状态、把 ToolResult 投影成展示模型。
// 服务端已经固定 panel→工具映射；客户端不传工具名、不写 localStorage 授权。
import { useCallback, useEffect, useState } from 'react';

import { nextRefreshDelayMs } from './auto-refresh.js';

export {
  adviceFeedbackOf,
  calibrationRows,
  dataOf,
  decisionLoopSummary,
  decisionReviewRows,
  errorOf,
  mapStateBody,
  publishedRunsByStrategy,
  researchRequestFor,
  resultOf,
  stateUrl,
  stockDetailUrl,
  stockHistoryUrl,
  stockResearchRequestFor,
  strategyExpression,
  strategyOperationRequestFor,
  strategyPartDataOf,
  strategyPartErrorOf,
  strategyPartOf,
  strategyText,
  watchlistOperationRequestFor,
  workspaceDataOf,
  workspaceErrorOf,
  workspaceOf,
} from './projection.js';

import { mapStateBody, stateUrl, stockDetailUrl, stockHistoryUrl } from './projection.js';

const fetchPanelState = async (panel, signal) => {
  const response = await fetch(stateUrl(panel), {
    signal,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return mapStateBody(await response.json());
};

/** 一次拉取单个面板状态；loading/error/refresh 语义与旧面板一致。 */
export function usePanelState(panel) {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState({
    loading: true,
    results: {},
    strategies: [],
    configuration: null,
    asOf: null,
    session: null,
    panelError: null,
    loadedAt: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setState((prev) => ({ ...prev, loading: true, panelError: null }));
    fetchPanelState(panel, controller.signal)
      .then((next) => {
        if (!alive) return;
        setState({
          loading: false,
          results: next.results,
          strategies: next.strategies,
          configuration: next.configuration,
          asOf: next.asOf,
          session: next.session,
          panelError: null,
          loadedAt: new Date(),
        });
      })
      .catch((error) => {
        if (!alive || controller.signal.aborted) return;
        setState((prev) => ({
          ...prev,
          loading: false,
          panelError: error instanceof Error ? error.message : String(error),
        }));
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [panel, tick]);

  const refresh = useCallback(() => setTick((value) => value + 1), []);
  return { ...state, refresh };
}

/**
 * 看盘页自动刷新：按服务端给的交易时段自调度。
 *
 * 盘中按固定间隔刷新；非交易时段等到服务端给的下次开盘时间再醒。页面隐藏时
 * 不发请求，回到前台立即刷新一次。刷新失败由 usePanelState 保留上一次成功画面。
 */
export function useAutoRefresh({ marketSession, nextSessionStart, refresh } = {}) {
  useEffect(() => {
    const doc = typeof document === 'undefined' ? null : document;
    if (doc === null) return undefined;
    let timer = null;
    let disposed = false;

    const clear = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const schedule = () => {
      clear();
      timer = setTimeout(tick, nextRefreshDelayMs({ marketSession, nextSessionStart }));
    };

    const tick = () => {
      timer = null;
      if (disposed) return;
      if (doc.visibilityState === 'visible') refresh();
      schedule();
    };

    const onVisibilityChange = () => {
      if (doc.visibilityState !== 'visible') return;
      clear();
      refresh();
      schedule();
    };

    doc.addEventListener('visibilitychange', onVisibilityChange);
    schedule();

    return () => {
      disposed = true;
      clear();
      doc.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [marketSession, nextSessionStart, refresh]);
}

function useStockRead(stockId, history, enabled = true) {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState({ loading: enabled, data: null, error: null });
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    let active = true;
    setState({ loading: true, data: null, error: null });
    fetch(history ? stockHistoryUrl(stockId) : stockDetailUrl(stockId), {
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (active) setState({ loading: false, data, error: null });
      })
      .catch(() => {
        if (active && !controller.signal.aborted)
          setState({
            loading: false,
            data: null,
            error: {
              message: history
                ? '历史日线暂时无法读取，请稍后重试。'
                : '行情暂时无法读取，请稍后重试。',
            },
          });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [stockId, history, enabled, tick]);
  return { ...state, refresh: useCallback(() => setTick((value) => value + 1), []) };
}

export const useStockDetail = (stockId) => useStockRead(stockId, false);
export const useStockHistory = (stockId, enabled) => useStockRead(stockId, true, enabled);
