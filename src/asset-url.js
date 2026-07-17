export function assetUrl(source) {
  return new URL(source, import.meta.url).href;
}
