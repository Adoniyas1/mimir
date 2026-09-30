import { BrowserWindow } from "electron";

/**
 * Very small, dependency-free markdown-ish → HTML formatter for export
 * purposes only — not a full renderer, just enough structure (headings,
 * paragraphs, fenced code blocks) that an exported answer or write-up reads
 * better than a wall of plain text. Deliberately not reusing the renderer's
 * MessageContent.tsx: that's a React component tied to the DOM it already
 * has; this runs in the main process against a throwaway hidden window.
 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function lightMarkdownToHtml(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inCode = false;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${paragraph.join(" ")}</p>`);
      paragraph = [];
    }
  };

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      flushParagraph();
      inCode = !inCode;
      out.push(inCode ? "<pre><code>" : "</code></pre>");
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(line));
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      const level = heading[1]?.length ?? 1;
      out.push(`<h${level}>${escapeHtml(heading[2] ?? "")}</h${level}>`);
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    paragraph.push(escapeHtml(line));
  }
  flushParagraph();
  return out.join("\n");
}

/** Renders `body` (light markdown) to a PDF buffer via a throwaway hidden
 * BrowserWindow — Chromium's own print pipeline does the real layout work,
 * we just hand it styled HTML. The window is always destroyed afterward,
 * success or failure. */
export async function renderTextToPdf(title: string, body: string): Promise<Buffer> {
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: Georgia, "Times New Roman", serif; color: #1a1a1a; line-height: 1.5; padding: 48px 56px; }
  h1, h2, h3, h4 { font-family: -apple-system, Helvetica, Arial, sans-serif; margin-top: 1.4em; }
  h1 { font-size: 22px; border-bottom: 1px solid #ccc; padding-bottom: 6px; }
  pre { background: #f4f4f4; padding: 10px 12px; border-radius: 4px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; }
  p { margin: 0 0 0.9em; white-space: pre-wrap; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${lightMarkdownToHtml(body)}
</body>
</html>`;

  const win = new BrowserWindow({ show: false });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return await win.webContents.printToPDF({ printBackground: true, pageSize: "Letter" });
  } finally {
    win.destroy();
  }
}
