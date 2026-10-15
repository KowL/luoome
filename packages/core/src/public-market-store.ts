/** 仅供公共行情缓存、在途租约和供应商配额使用，不能存放租户身份或投资数据。 */
export interface PublicMarketStore {
  read(key: string, now: number): string | null;
  /** 同一存储内原子读改写；异常必须回滚，过期记录可清理。 */
  update<T>(
    key: string,
    now: number,
    retainUntil: number,
    change: (value: string | null) => { readonly value: string; readonly result: T },
  ): T;
}
