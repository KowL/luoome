// dsh-luoome client 数据层：宿主认证只读路由 /api/luoome/state?panel=...
//
// 浏览器只做两件事：fetch 同源 no-store 状态、把 ToolResult 投影成展示模型。
// 服务端已经固定 panel→工具映射；客户端不传工具名、不写 localStorage 授权。
import { useCallback, useEffect, useState } from 'react';

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
  workspaceDataOf,
  workspaceErrorOf,
  workspaceOf,
} from './projection.js';

import { mapStateBody, stateUrl } from './projection.js';

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
    asOf: null,
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
          asOf: next.asOf,
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
