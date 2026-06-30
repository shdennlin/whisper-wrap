/**
 * Parity guard for the AI-provider editor strings (ai-provider-settings task
 * 4.4): every new `aiProvider.*` key must exist in BOTH `en` and `zh-TW` with a
 * non-empty value.
 */

import { describe, it, expect } from "vitest";
import { STRINGS } from "./strings";

const AI_PROVIDER_KEYS = [
  "aiProvider.cardTitle",
  "aiProvider.providerLabel",
  "aiProvider.presetGemini",
  "aiProvider.presetOpenai",
  "aiProvider.presetOpenrouter",
  "aiProvider.presetOllama",
  "aiProvider.presetCustom",
  "aiProvider.baseUrlLabel",
  "aiProvider.modelLabel",
  "aiProvider.modelPlaceholder",
  "aiProvider.apiKeyLabel",
  "aiProvider.apiKeyHintSet",
  "aiProvider.apiKeyHintUnset",
  "aiProvider.apiKeyPlaceholder",
  "aiProvider.refreshModels",
  "aiProvider.refreshing",
  "aiProvider.testConnection",
  "aiProvider.testing",
  "aiProvider.save",
  "aiProvider.saving",
  "aiProvider.saved",
  "aiProvider.saveError",
  "aiProvider.testOk",
  "aiProvider.testFailed",
  "aiProvider.modelsError",
  "aiProvider.modelsEmpty",
] as const;

describe("ai-provider i18n strings", () => {
  for (const key of AI_PROVIDER_KEYS) {
    it(`has en + zh-TW for ${key}`, () => {
      const en = (STRINGS.en as Record<string, string>)[key];
      const zh = (STRINGS["zh-TW"] as Record<string, string>)[key];
      expect(en, `missing en for ${key}`).toBeTruthy();
      expect(zh, `missing zh-TW for ${key}`).toBeTruthy();
    });
  }
});
