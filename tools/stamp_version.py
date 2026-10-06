"""Stamp a version on every module, stylesheet and data URL so browsers fetch new files
after each release (GitHub Pages lets browsers cache files for ~10 minutes).

Rewrites the import map in index.html: each local module maps to itself plus ?v=<version>,
which also covers modules imported relatively from other modules. Run before publishing:

  python tools/stamp_version.py            # version = current git short hash
  git commit -am "Stamp version" && git push origin main && git push origin main:gh-pages
"""

import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    version = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip() or "dev"
    html_path = ROOT / "index.html"
    html = html_path.read_text()

    m = re.search(r'(<script type="importmap">\s*)(\{.*?\})(\s*</script>)', html, re.S)
    imports = json.loads(m.group(2))
    imports["imports"] = {k: v for k, v in imports["imports"].items() if not k.startswith("./js/")}
    for js in sorted((ROOT / "js").glob("*.js")):
        imports["imports"][f"./js/{js.name}"] = f"./js/{js.name}?v={version}"
    block = json.dumps(imports, indent=2).replace("\n", "\n    ")
    html = html[:m.start(2)] + block + html[m.end(2):]

    html = re.sub(r'href="css/style\.css(\?v=[^"]*)?"', f'href="css/style.css?v={version}"', html)
    html = re.sub(r'src="js/main\.js(\?v=[^"]*)?"', f'src="js/main.js?v={version}"', html)
    html = re.sub(r'<meta name="app-version" content="[^"]*">', f'<meta name="app-version" content="{version}">', html)
    if 'name="app-version"' not in html:
        html = html.replace('<meta charset="utf-8">', f'<meta charset="utf-8">\n  <meta name="app-version" content="{version}">')
    html_path.write_text(html)
    print(f"Stamped version {version}")


if __name__ == "__main__":
    main()
