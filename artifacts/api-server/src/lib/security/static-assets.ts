export type CompressionSuffix = ".br" | ".gz";

// Vite emits precompressed build assets directly beneath dist/assets. Keep the
// request-derived portion to one conservative basename; nested paths, encoded
// traversal text, platform separators, absolute paths, and control characters
// all fall through to the normal static handler.
const COMPRESSIBLE_ASSET_BASENAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:css|js|json|svg)$/;

export function compressedAssetFileName(
  requestPath: string,
  suffix: CompressionSuffix
): string | null {
  return COMPRESSIBLE_ASSET_BASENAME.test(requestPath)
    ? `${requestPath}${suffix}`
    : null;
}
