// 契约定义在 core（`tools` 需要它，而 `tools` 不能依赖 `adapters`）。
export type {
  AnnouncementDisclosure,
  DisclosureSource,
  VendorSnapshot,
} from '@luoome/core';
export { describeDisclosureSource, ingestHashOf } from '@luoome/core';
