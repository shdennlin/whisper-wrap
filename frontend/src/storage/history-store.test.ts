/**
 * Tests for the history-store (Decision 4: incremental localStorage write per
 * final, capped at 20 sessions).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  HistoryStore,
  STORAGE_KEY,
  DEFAULT_RETENTION,
  formatSessionDuration,
  type SessionRecord,
} from "./history-store";

describe("formatSessionDuration", () => {
  it("shows tenths-of-second under one minute", () => {
    expect(formatSessionDuration(0)).toBe("0.0s");
    expect(formatSessionDuration(300)).toBe("0.3s");
    expect(formatSessionDuration(12_345)).toBe("12.3s");
    expect(formatSessionDuration(59_900)).toBe("59.9s");
  });

  it("shows mm:ss.x at or over one minute", () => {
    expect(formatSessionDuration(60_000)).toBe("1:00.0");
    expect(formatSessionDuration(60_500)).toBe("1:00.5");
    expect(formatSessionDuration(125_400)).toBe("2:05.4");
    expect(formatSessionDuration(600_000)).toBe("10:00.0");
  });
});

describe("HistoryStore", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("starts a session, appends finals incrementally, and persists immediately", () => {
    const store = new HistoryStore();
    const id = store.startSession();

    store.appendFinal(id, { text: "hello", start_ms: 0, end_ms: 500 });
    // Even before stop(), the localStorage should reflect the in-flight session.
    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { sessions: SessionRecord[] };
    expect(parsed.sessions).toHaveLength(1);
    expect(parsed.sessions[0].finals).toHaveLength(1);
    expect(parsed.sessions[0].finals[0].text).toBe("hello");
    expect(parsed.sessions[0].ended_at).toBeNull();

    store.appendFinal(id, { text: "world", start_ms: 500, end_ms: 1000 });
    const parsed2 = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY)!,
    ) as { sessions: SessionRecord[] };
    expect(parsed2.sessions[0].finals).toHaveLength(2);
    expect(parsed2.sessions[0].finals[1].text).toBe("world");
  });

  it("stop() sets ended_at on the active session", () => {
    const store = new HistoryStore();
    const id = store.startSession();
    store.appendFinal(id, { text: "x", start_ms: 0, end_ms: 100 });
    store.stopSession(id);
    const parsed = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY)!,
    ) as { sessions: SessionRecord[] };
    expect(parsed.sessions[0].ended_at).toBeTypeOf("number");
    expect(parsed.sessions[0].ended_at).toBeGreaterThan(0);
  });

  it("caps the list at 20 sessions, evicting oldest by started_at", () => {
    const store = new HistoryStore();
    // Manually pre-populate 20 sessions so the cap triggers cleanly.
    for (let i = 0; i < 20; i++) {
      store.startSession();
    }
    expect(store.list()).toHaveLength(20);
    const oldestId = store.list().slice(-1)[0].id; // list() returns newest-first
    // 21st session should evict the oldest.
    store.startSession();
    const ids = store.list().map((s) => s.id);
    expect(ids).toHaveLength(20);
    expect(ids).not.toContain(oldestId);
  });

  it("records action_runs against the session", () => {
    const store = new HistoryStore();
    const id = store.startSession();
    store.appendActionRun(id, {
      action_id: "summarize",
      prompt: "wrapped prompt",
      answer: "Gemini answer",
      ran_at: 1715800000000,
    });
    const parsed = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY)!,
    ) as { sessions: SessionRecord[] };
    expect(parsed.sessions[0].action_runs).toHaveLength(1);
    expect(parsed.sessions[0].action_runs[0].action_id).toBe("summarize");
    expect(parsed.sessions[0].action_runs[0].answer).toBe("Gemini answer");
  });

  it("deleteSession removes the entry from storage", () => {
    const store = new HistoryStore();
    const a = store.startSession();
    const b = store.startSession();
    store.deleteSession(a);
    const remaining = store.list().map((s) => s.id);
    expect(remaining).toEqual([b]);
  });

  it("setRetention(n) evicts surplus immediately", () => {
    const store = new HistoryStore();
    for (let i = 0; i < 10; i++) store.startSession();
    expect(store.list()).toHaveLength(10);
    store.setRetention(5);
    expect(store.list()).toHaveLength(5);
  });

  it("survives a 'crash' (new HistoryStore reads back finals written mid-session)", () => {
    // First store writes 3 finals without stopping.
    const id = new HistoryStore().startSession();
    new HistoryStore().appendFinal(id, { text: "one", start_ms: 0, end_ms: 100 });
    new HistoryStore().appendFinal(id, { text: "two", start_ms: 100, end_ms: 200 });
    new HistoryStore().appendFinal(id, { text: "three", start_ms: 200, end_ms: 300 });

    // Simulate a crash: a brand-new store instance reads the same localStorage.
    const reloaded = new HistoryStore();
    const sessions = reloaded.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].finals.map((f) => f.text)).toEqual(["one", "two", "three"]);
    expect(sessions[0].ended_at).toBeNull();
  });

  it("DEFAULT_RETENTION is 20 per spec", () => {
    expect(DEFAULT_RETENTION).toBe(20);
  });
});
