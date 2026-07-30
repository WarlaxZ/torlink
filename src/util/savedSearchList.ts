export function toggleSavedSearches(current: readonly string[], raw: string, limit = 50): string[] {
  const query = raw.trim();
  if (!query) return [...current];
  return current.includes(query)
    ? current.filter((item) => item !== query)
    : [query, ...current].slice(0, limit);
}
