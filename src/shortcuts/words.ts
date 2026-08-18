export function words(id: string): string {
  const segments = id.split(".");
  let tail = segments.pop() ?? id;
  if (tail.length <= 6 && segments.length > 1) tail = `${segments.pop()} ${tail}`;
  return tail
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .trim();
}
