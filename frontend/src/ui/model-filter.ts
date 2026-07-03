/**
 * Pure filter for the model picker.
 *
 * Typed against a minimal structural shape (not the generated OpenAPI client
 * type) so this module stays independent of the API-client regeneration.
 */
export interface FilterableModel {
  languages: string[];
  tags: string[];
}

/**
 * Filter models by a set of selected language/tag facets.
 *
 * Semantics: OR over the union of each model's `languages` and `tags`.
 * - Empty `selected` means "no filter" → every model is returned.
 * - Otherwise a model is included iff at least one of its languages ∪ tags is
 *   present in `selected`. A model with no languages and no tags matches
 *   nothing while a filter is active.
 *
 * Does not mutate the input array.
 */
export function filterModels<T extends FilterableModel>(models: T[], selected: string[]): T[] {
  if (selected.length === 0) return models.filter(() => true);
  const wanted = new Set(selected);
  return models.filter((model) =>
    [...model.languages, ...model.tags].some((facet) => wanted.has(facet)),
  );
}
