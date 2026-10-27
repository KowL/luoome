import { useCallback, useEffect, useRef, useState } from 'react';
import {
  keepOperationCredential,
  operationIsUnsettled,
  requestResearch,
  researchErrorText,
} from './research-transport.js';

export function useResearchRead(path, body, { enabled = true, poll = false } = {}) {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  const requestKey = `${path}:${serialized ?? ''}`;
  const [tick, setTick] = useState(0);
  const [state, setState] = useState({ data: null, error: null, loading: enabled });
  const previousRequest = useRef(null);
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    let active = true;
    const sameRequest = previousRequest.current === requestKey;
    previousRequest.current = requestKey;
    setState((previous) => ({
      data: sameRequest ? previous.data : null,
      loading: true,
      error: null,
    }));
    requestResearch(path, {
      ...(serialized === undefined ? {} : { body: JSON.parse(serialized) }),
      signal: controller.signal,
    })
      .then((data) => {
        if (active) setState({ data, error: null, loading: false });
      })
      .catch((error) => {
        if (active && !controller.signal.aborted)
          setState((previous) => ({
            ...previous,
            error: researchErrorText(error),
            loading: false,
          }));
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [path, serialized, enabled, tick]);
  const polling = typeof poll === 'function' ? poll(state.data) : poll;
  useEffect(() => {
    if (!enabled || !polling || state.loading) return undefined;
    const timer = setTimeout(() => setTick((value) => value + 1), 5000);
    return () => clearTimeout(timer);
  }, [enabled, polling, state.loading]);
  const current =
    previousRequest.current === requestKey ? state : { data: null, error: null, loading: enabled };
  return { ...current, refresh: useCallback(() => setTick((value) => value + 1), []) };
}

const rememberedOperation = (key) => {
  try {
    const id = globalThis.localStorage?.getItem(key);
    return id ? { operationId: id, state: 'unknown' } : null;
  } catch {
    return null;
  }
};

export function useResearchOperation({ accountId, strategyId, onCompleted }) {
  const key = `luoome:research-operation:${accountId}:${strategyId}`;
  const [operation, setOperation] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [expired, setExpired] = useState(false);
  const active = useRef(false);
  const completed = useRef(null);
  const completion = useRef(onCompleted);
  completion.current = onCompleted;

  const accept = (next, recovered = false) => {
    setOperation((previous) => keepOperationCredential(previous, next));
    if (
      ['succeeded', 'failed', 'cancelled'].includes(next.state) &&
      completed.current !== next.operationId
    ) {
      completed.current = next.operationId;
      completion.current?.(next, { recovered });
    }
  };
  useEffect(() => {
    if (!accountId) return;
    const remembered = rememberedOperation(key);
    setOperation(remembered);
    setError(null);
    if (!remembered) return undefined;
    const controller = new AbortController();
    requestResearch(`api/luoome/operations/${encodeURIComponent(remembered.operationId)}`, {
      signal: controller.signal,
    })
      .then((next) => {
        if (!controller.signal.aborted) accept(next, true);
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        if (failure.kind === 'not_found') setOperation({ ...remembered, state: 'failed' });
        setError(researchErrorText(failure));
      });
    return () => controller.abort();
  }, [accountId, key]);
  useEffect(() => {
    if (operation?.state !== 'pending') {
      setExpired(false);
      return undefined;
    }
    const remaining = new Date(operation.expiresAt).getTime() - Date.now();
    setExpired(remaining <= 0);
    if (remaining <= 0) return undefined;
    const timer = setTimeout(() => setExpired(true), remaining);
    return () => clearTimeout(timer);
  }, [operation]);

  const act = async (action, plan) => {
    if (active.current || !accountId) return;
    active.current = true;
    setBusy(true);
    setError(null);
    let pending = operation;
    try {
      if (action === 'prepare') {
        if (operationIsUnsettled(pending) && !expired) return;
        const id = crypto.randomUUID();
        pending = { operationId: id, state: 'preparing', tool: plan.tool };
        setOperation(pending);
        try {
          globalThis.localStorage?.setItem(key, id);
        } catch {
          /* 读取回执仍可在当前页面继续。 */
        }
        accept(
          await requestResearch('api/luoome/operations/prepare', {
            body: {
              id,
              tool: plan.tool,
              input: typeof plan.input === 'function' ? plan.input(id) : plan.input,
            },
          }),
        );
      } else if (action === 'check') {
        accept(
          await requestResearch(`api/luoome/operations/${encodeURIComponent(pending.operationId)}`),
        );
      } else {
        const next = await requestResearch(
          `api/luoome/operations/${encodeURIComponent(pending.operationId)}/${action}`,
          {
            body: action === 'reconcile' ? {} : { token: pending.confirmationToken },
          },
        );
        accept(
          action === 'cancel'
            ? await requestResearch(
                `api/luoome/operations/${encodeURIComponent(pending.operationId)}`,
              )
            : next,
        );
      }
    } catch (failure) {
      if (action === 'check' && failure.kind === 'not_found') {
        setOperation({ ...pending, state: 'failed', confirmationToken: undefined });
        setError('原操作尚未建立，可收起回执后重新准备。');
        return;
      }
      if (action === 'confirm' || pending?.state === 'preparing')
        setOperation({ ...pending, state: 'unknown', confirmationToken: undefined });
      setError(`${researchErrorText(failure)} 请先核对原操作状态。`);
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  return {
    operation,
    busy,
    error,
    expired,
    locked: busy || (operationIsUnsettled(operation) && !expired),
    prepare: (tool, input) => act('prepare', { tool, input }),
    confirm: () => act('confirm'),
    cancel: () => act('cancel'),
    check: () => act('check'),
    reconcile: () => act('reconcile'),
    clear: () => {
      if (operationIsUnsettled(operation) && !expired) return;
      try {
        globalThis.localStorage?.removeItem(key);
      } catch {
        /* 无持久存储时只清除页面回执。 */
      }
      setOperation(null);
      setError(null);
    },
  };
}
