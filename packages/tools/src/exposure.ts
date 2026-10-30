// 暴露面判定的公开入口（M2-09 / T12）。
//
// 实现已归位到 `exposure/judge.ts`，本文件只做再导出，保留 `./exposure.js` 这个既有
// 说明符：`@luoome/tools` 的桶导出与 `exposure/classify.ts` 都从这里取，改名会让
// 判定层的唯一入口分裂成两条路径。新代码请直接 import `exposure/judge.js`。
export * from './exposure/judge.js';
