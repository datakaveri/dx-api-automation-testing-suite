import { describe, expect, it } from "vitest";
import { formatDate, formatDuration, formatLastRun, formatNumber, formatRunDate, formatRunTime, formatSize, initials, percent, shortEnvironment } from "../src/format";

describe("format", () => {
  it("formats dates and falls back for null", () => {
    expect(formatDate(null)).toBe("Never");
    expect(formatDate("2026-10-01T10:00:00Z")).toContain("2026");
    expect(formatRunDate(null)).toBe("Never");
    expect(formatRunDate("2026-10-01T10:00:00Z")).toMatch(/2026/);
    expect(formatRunTime(null)).toBe("");
    expect(formatRunTime("2026-10-01T10:00:00Z")).toMatch(/(AM|PM)/);
  });

  it("formats durations", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(250)).toBe("250 ms");
    expect(formatDuration(1500)).toBe("1.5 s");
  });

  it("formats sizes", () => {
    expect(formatSize(null)).toBe("—");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
  });

  it("formats the last run relative to today", () => {
    const now = new Date(2026, 9, 3, 15, 0);
    expect(formatLastRun(null, now)).toBe("Never");
    expect(formatLastRun(new Date(2026, 9, 3, 10, 42).toISOString(), now)).toBe("Today, 10:42 AM");
    expect(formatLastRun(new Date(2026, 9, 2, 21, 5).toISOString(), now)).toBe("Yesterday, 9:05 PM");
    expect(formatLastRun(new Date(2026, 8, 28, 9, 0).toISOString(), now)).toBe("Sep 28, 9:00 AM");
  });

  it("formats numbers, percentages, initials and environment names", () => {
    expect(formatNumber(2698)).toBe("2,698");
    expect(percent(2696, 2698)).toBe(99.9);
    expect(percent(1, 0)).toBe(0);
    expect(initials("Control Plane")).toBe("CP");
    expect(initials("OGC")).toBe("OG");
    expect(initials("")).toBe("?");
    expect(shortEnvironment("contrlplane-evm.postman_environment.json")).toBe("contrlplane-evm");
    expect(shortEnvironment("dev.json")).toBe("dev.json");
  });
});
