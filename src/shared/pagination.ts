/** Cursor pagination (spec-2 FR-231): pass `nextCursor` back as `cursor` to get the next page. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
