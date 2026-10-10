export interface RecordStore {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  remove(key: string): void;
  list<T>(prefix: string): T[];
  transaction<T>(action: () => T): T;
  expire(prefix: string, now: number): void;
}
