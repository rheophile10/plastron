import type { MemoCache } from "../types/index.js";

// ============================================================================
// LRU memoization cache — ref-keyed chain of Maps + doubly-linked list for
// access ordering. See docs/1-design/3-accepted/03-caching/execution-hooks.md "L1 cache slot".
//
// Lookup:
//   walk the chain by Object.is on each input key in order; final node
//   yields an Entry whose .value is the cached output. Touch moves the
//   entry to the head of the access list.
//
// Eviction:
//   when size > maxEntries, evict the tail of the access list. Removes
//   the entry from both the list and the chain map.
//
// Empty intermediate Maps from eviction aren't pruned in v1 — the
// memory cost is a small constant per evicted path; pruning adds
// branching cost on every eviction. Acceptable trade-off given the
// maxEntries cap.
// ============================================================================

const ENTRY_MARKER = Symbol("memo-entry");

interface Entry {
  readonly [ENTRY_MARKER]: true;
  keys: readonly unknown[];
  value: unknown;
  prev: Entry | null;
  next: Entry | null;
}

const isEntry = (x: unknown): x is Entry =>
  x !== null && typeof x === "object" && (x as { [ENTRY_MARKER]?: true })[ENTRY_MARKER] === true;

export class LruMemoCache implements MemoCache {
  readonly maxEntries: number;
  private root: Map<unknown, unknown> = new Map();
  private head: Entry | null = null;
  private tail: Entry | null = null;
  private _size = 0;

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
  }

  get size(): number { return this._size; }

  get(keys: readonly unknown[]): { value: unknown } | undefined {
    if (keys.length === 0) return undefined;
    let node: unknown = this.root;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!(node instanceof Map)) return undefined;
      const next = node.get(keys[i]);
      if (next === undefined) return undefined;
      node = next;
    }
    if (!(node instanceof Map)) return undefined;
    const entry = node.get(keys[keys.length - 1]);
    if (!isEntry(entry)) return undefined;
    this.touch(entry);
    return { value: entry.value };
  }

  set(keys: readonly unknown[], value: unknown): void {
    if (keys.length === 0) return;
    let node: Map<unknown, unknown> = this.root;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      let next = node.get(k);
      if (!(next instanceof Map)) {
        next = new Map();
        node.set(k, next);
      }
      node = next as Map<unknown, unknown>;
    }
    const lastKey = keys[keys.length - 1];
    const existing = node.get(lastKey);
    if (isEntry(existing)) {
      existing.value = value;
      this.touch(existing);
      return;
    }
    const entry: Entry = {
      [ENTRY_MARKER]: true,
      keys: [...keys],
      value,
      prev: null,
      next: null,
    };
    node.set(lastKey, entry);
    this._size++;
    this.linkAtHead(entry);
    while (this._size > this.maxEntries) this.evictTail();
  }

  clear(): void {
    this.root = new Map();
    this.head = null;
    this.tail = null;
    this._size = 0;
  }

  private touch(entry: Entry): void {
    if (entry === this.head) return;
    this.unlink(entry);
    this.linkAtHead(entry);
  }

  private linkAtHead(entry: Entry): void {
    entry.prev = null;
    entry.next = this.head;
    if (this.head) this.head.prev = entry;
    this.head = entry;
    if (!this.tail) this.tail = entry;
  }

  private unlink(entry: Entry): void {
    if (entry.prev) entry.prev.next = entry.next;
    if (entry.next) entry.next.prev = entry.prev;
    if (entry === this.head) this.head = entry.next;
    if (entry === this.tail) this.tail = entry.prev;
    entry.prev = null;
    entry.next = null;
  }

  private evictTail(): void {
    const t = this.tail;
    if (!t) return;
    this.unlink(t);
    // Remove from chain map.
    let node: Map<unknown, unknown> = this.root;
    for (let i = 0; i < t.keys.length - 1; i++) {
      const next = node.get(t.keys[i]);
      if (!(next instanceof Map)) {
        this._size--;
        return;
      }
      node = next as Map<unknown, unknown>;
    }
    node.delete(t.keys[t.keys.length - 1]);
    this._size--;
  }
}

export const makeMemoCache = (maxEntries = 128): MemoCache =>
  new LruMemoCache(maxEntries);
