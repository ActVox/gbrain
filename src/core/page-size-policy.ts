/**
 * Large-page policy (Wave A): the one ceiling every raisable ingress bound
 * derives from, and the inline threshold above which a page is treated as
 * large (post-commit embedding, title-tier context, bounded history).
 */
export const PAGE_MAX_BYTES = 24 * 1024 ** 2;
export const CODE_FILE_MAX_BYTES = 5_000_000;
export const PAGE_INLINE_MAX_BYTES = 1024 ** 2;
export function isLargePageBytes(bytes: number): boolean {
  return bytes > PAGE_INLINE_MAX_BYTES;
}
