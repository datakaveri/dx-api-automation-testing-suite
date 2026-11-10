export function formatDate(value: string | null): string {
  return value ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Never";
}

export function formatRunDate(value: string | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(new Date(value));
}

export function formatRunTime(value: string | null): string {
  if (!value) return "";
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(new Date(value));
}

// "Today, 10:42 AM", "Yesterday, 9:05 PM" or "Oct 1, 10:00 AM".
export function formatLastRun(value: string | null, now = new Date()): string {
  if (!value) return "Never";
  const date = new Date(value);
  const time = formatRunTime(value);
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(date)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
  return `${day}, ${time}`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-IN");
}

// Share of a in b as a percentage with one decimal; 0 when b is 0.
export function percent(a: number, b: number): number {
  return b ? Math.round((a / b) * 1000) / 10 : 0;
}

// "Control Plane" -> "CP", "OGC" -> "OG".
export function initials(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (words[0] ?? "?").slice(0, 2).toUpperCase();
}

export function shortEnvironment(fileName: string): string {
  return fileName.replace(/\.postman_environment\.json$/i, "");
}

export function formatDuration(value: number | null): string {
  if (value === null) return "—";
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
}

export function formatSize(value: number | null): string {
  if (value === null) return "—";
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;
}
