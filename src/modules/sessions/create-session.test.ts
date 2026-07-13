import { describe, it, expect } from "vitest";
import { buildNewSessionPayload, normalizeStartTime } from "./create-session";

describe("normalizeStartTime", () => {
  it("null/vacío → null", () => {
    expect(normalizeStartTime(null)).toBeNull();
    expect(normalizeStartTime(undefined)).toBeNull();
    expect(normalizeStartTime("")).toBeNull();
    expect(normalizeStartTime("   ")).toBeNull();
  });
  it('"HH:MM" → "HH:MM:00"', () => {
    expect(normalizeStartTime("09:00")).toBe("09:00:00");
    expect(normalizeStartTime("20:05")).toBe("20:05:00");
    expect(normalizeStartTime("8:30")).toBe("8:30:00");
  });
  it('"HH:MM:SS" se deja igual', () => {
    expect(normalizeStartTime("09:00:00")).toBe("09:00:00");
    expect(normalizeStartTime("20:05:30")).toBe("20:05:30");
  });
});

describe("buildNewSessionPayload", () => {
  const base = { course_id: "c1", session_date: "2026-07-14", created_by: "u1" };

  it("incluye solo obligatorios cuando no se pasa nada más", () => {
    expect(buildNewSessionPayload(base)).toEqual({
      course_id: "c1",
      session_date: "2026-07-14",
      created_by: "u1",
    });
  });

  it("OMITE campos undefined (aplica default DB), incluye null explícito", () => {
    const p = buildNewSessionPayload({ ...base, title: null, cut_id: undefined });
    expect(p).toHaveProperty("title", null);
    expect(p).not.toHaveProperty("cut_id");
    expect(p).not.toHaveProperty("meeting_url");
    expect(p).not.toHaveProperty("recording_video_id");
  });

  it("normaliza start_time dentro del payload", () => {
    const p = buildNewSessionPayload({ ...base, start_time: "20:00", duration_minutes: 105 });
    expect(p.start_time).toBe("20:00:00");
    expect(p.duration_minutes).toBe(105);
  });

  it("shape del board (meeting_url, sin cut_id/recording_video_id)", () => {
    const p = buildNewSessionPayload({
      ...base,
      title: "Sesión 1",
      start_time: "09:00",
      duration_minutes: 90,
      meeting_url: "https://meet",
      recording_url: null,
      notes_url: null,
    });
    expect(p).toEqual({
      course_id: "c1",
      session_date: "2026-07-14",
      created_by: "u1",
      title: "Sesión 1",
      start_time: "09:00:00",
      duration_minutes: 90,
      meeting_url: "https://meet",
      recording_url: null,
      notes_url: null,
    });
  });

  it("shape de asistencia (cut_id + recording_video_id, sin meeting_url)", () => {
    const p = buildNewSessionPayload({
      ...base,
      title: null,
      start_time: null,
      duration_minutes: null,
      cut_id: "cut1",
      recording_url: null,
      recording_video_id: "vid1",
      notes_url: null,
    });
    expect(p).not.toHaveProperty("meeting_url");
    expect(p.cut_id).toBe("cut1");
    expect(p.recording_video_id).toBe("vid1");
    expect(p.start_time).toBeNull();
  });
});
