import { describe, expect, it } from "vitest";

import { type FilterableModel, filterModels } from "./model-filter";

interface NamedModel extends FilterableModel {
  name: string;
}

const models: NamedModel[] = [
  { name: "breeze-asr-25", languages: ["zh-TW", "en"], tags: ["code-switching"] },
  { name: "large-v3-turbo", languages: ["multilingual"], tags: ["fast"] },
  { name: "whisper-large-v3", languages: ["multilingual"], tags: ["high-accuracy"] },
  { name: "whisper-small", languages: ["multilingual"], tags: ["balanced"] },
  { name: "whisper-base", languages: ["multilingual"], tags: ["fast"] },
  { name: "whisper-tiny", languages: ["multilingual"], tags: ["fast"] },
];

function names(selected: string[]): string[] {
  return filterModels(models, selected).map((m) => m.name);
}

describe("filterModels", () => {
  it("returns all models when selected is empty (no filter)", () => {
    expect(names([])).toEqual([
      "breeze-asr-25",
      "large-v3-turbo",
      "whisper-large-v3",
      "whisper-small",
      "whisper-base",
      "whisper-tiny",
    ]);
  });

  it("filters by a single language", () => {
    expect(names(["zh-TW"])).toEqual(["breeze-asr-25"]);
  });

  it("filters by a single tag", () => {
    expect(names(["fast"])).toEqual(["large-v3-turbo", "whisper-base", "whisper-tiny"]);
  });

  it("ORs across a language and a tag (union of both fields)", () => {
    expect(names(["zh-TW", "fast"])).toEqual([
      "breeze-asr-25",
      "large-v3-turbo",
      "whisper-base",
      "whisper-tiny",
    ]);
  });

  it("filters by a tag that only one model carries", () => {
    expect(names(["code-switching"])).toEqual(["breeze-asr-25"]);
  });

  it("does not mutate the input array", () => {
    const input = models.slice();
    filterModels(input, ["fast"]);
    expect(input).toHaveLength(6);
    expect(input).toEqual(models);
  });

  it("excludes a model with empty languages and tags when a filter is active", () => {
    const empties: FilterableModel[] = [{ languages: [], tags: [] }];
    expect(filterModels(empties, ["fast"])).toEqual([]);
    expect(filterModels(empties, [])).toEqual(empties);
  });
});
