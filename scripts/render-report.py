"""Renders docs/sdk-report.md to docs/sdk-report.pdf.

Markdown to HTML with Python's `markdown` package, then HTML to PDF with the Playwright Chromium that `web/` already
depends on (`pnpm --filter @treasury/web exec playwright install chromium` once). Section 5 is filled from
docs/issue-status.md, so the PDF and the working list never disagree.

    python3 scripts/render-report.py
"""
import pathlib, re, subprocess, tempfile
import markdown

ROOT = pathlib.Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"

source = (DOCS / "sdk-report.md").read_text()
status = (DOCS / "issue-status.md").read_text()
status = re.sub(r"^# .*\n+", "", status, count=1)  # its own title; the report gives the section's
source = source.replace("<!-- ISSUE_STATUS -->", status)
body = markdown.markdown(source, extensions=["tables", "fenced_code", "sane_lists"])

CSS = """
@page { size: A4; margin: 18mm 16mm 20mm; }
body { font: 10pt/1.5 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1a1a1a; }
h1 { font-size: 22pt; margin: 0 0 4pt; letter-spacing: -0.3pt; }
h1 + p { font-size: 11.5pt; color: #444; margin-top: 0; }
p.meta { color: #777; font-size: 9pt; border-bottom: 1px solid #ddd; padding-bottom: 10pt; }
h2 { font-size: 14pt; margin: 20pt 0 6pt; padding-top: 6pt; border-top: 2px solid #e2b007; page-break-after: avoid; }
h3 { font-size: 11.5pt; margin: 14pt 0 4pt; page-break-after: avoid; }
table { width: 100%; border-collapse: collapse; margin: 6pt 0 10pt; font-size: 8.6pt; page-break-inside: auto; }
tr { page-break-inside: avoid; }
th { text-align: left; background: #f4f1e6; border-bottom: 1.5px solid #c9b46a; padding: 4pt 5pt; }
td { border-bottom: 0.6px solid #e3e3e3; padding: 3.5pt 5pt; vertical-align: top; overflow-wrap: break-word; }
code { font: 8.4pt Menlo, monospace; background: #f3f3f3; padding: 0 2pt; border-radius: 2pt; }
li { margin: 2pt 0; }
strong { color: #000; }
"""
html = f"<!doctype html><html><head><meta charset='utf-8'><title>Treasury and the MultiAgency SDK</title><style>{CSS}</style></head><body>{body}</body></html>"

with tempfile.TemporaryDirectory() as tmp:
    page = pathlib.Path(tmp) / "report.html"
    page.write_text(html)
    out = DOCS / "sdk-report.pdf"
    script = f"""
const {{ chromium }} = await import("playwright");
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto({str(page.as_uri())!r});
await page.pdf({{ path: {str(out)!r}, format: "A4", printBackground: true,
  displayHeaderFooter: true, headerTemplate: "<span></span>",
  footerTemplate: '<div style="font-size:7pt;color:#999;width:100%;text-align:center">Treasury and the MultiAgency SDK · <span class="pageNumber"></span> / <span class="totalPages"></span></div>' }});
await browser.close();
"""
    subprocess.run(["node", "--input-type=module", "-e", script], cwd=ROOT / "web", check=True)
    print(f"wrote {out.relative_to(ROOT)}")
