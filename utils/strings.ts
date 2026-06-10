export const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

/** Case-insensitive, numeric-aware name ordering ("Basin 2" < "Basin 10") */
export const compareNames = (a: string, b: string): number =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
