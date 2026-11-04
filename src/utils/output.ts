const colorEnabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function wrap(code: number, text: string): string {
  return colorEnabled ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export const style = {
  bold: (text: string) => wrap(1, text),
  dim: (text: string) => wrap(2, text),
  red: (text: string) => wrap(31, text),
  green: (text: string) => wrap(32, text),
  yellow: (text: string) => wrap(33, text),
  blue: (text: string) => wrap(34, text),
  magenta: (text: string) => wrap(35, text),
  cyan: (text: string) => wrap(36, text),
  gray: (text: string) => wrap(90, text),
};

export function truncateText(
  text: string,
  maxChars: number,
  label = "output dipotong",
): string {
  if (text.length <= maxChars) {
    return text;
  }

  const notice = `\n... [${label}: ${text.length - maxChars} karakter] ...\n`;
  const remaining = Math.max(0, maxChars - notice.length);
  const headLength = Math.floor(remaining * 0.7);
  const tailLength = remaining - headLength;

  return `${text.slice(0, headLength)}${notice}${text.slice(-tailLength)}`;
}

export function previewText(text: string, maxChars = 240): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxChars) {
    return singleLine;
  }
  return `${singleLine.slice(0, maxChars)}…`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatJson(value: unknown, maxChars = 1_200): string {
  let rendered: string;
  try {
    const json = JSON.stringify(value, null, 2);
    rendered = json ?? String(value);
  } catch {
    rendered = String(value);
  }
  return truncateText(rendered, maxChars, "argumen dipotong");
}
