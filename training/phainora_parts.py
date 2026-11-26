"""Splits a Phainora site into the three steps Phainora AI builds it in: 1 design (<head> + CSS), 2 content (<body>, no scripts),
3 script (translations + animation). Each step fits the 12288-token training limit that a whole site (~30k chars) does not.
The same prompts are used by the app, so the model is asked exactly what it was trained on."""
import re

STEP1 = "\n\nالخطوة 1 من 3: اكتب أول الملف لحد </head>: الـ <head> كامل بالخطوط والـ CSS كله، ومن غير <body>."
STEP2 = ("\n\nالخطوة 2 من 3: ده أول الملف (التصميم) اللي اتكتب:\n```html\n{head}\n```\n"
         "اكتب الـ <body> كامل بكل السكاشن والنصوص، بنفس الكلاسات اللي في الـ CSS، ومن غير أي <script>.")
STEP3 = ("\n\nالخطوة 3 من 3: ده الـ <body> اللي اتكتب:\n```html\n{body}\n```\n"
         "اكتب السكريبتات بس (الترجمة للإنجليزي بزرار EN، والأنيميشن، وأي تفاعل) لحد </html>.")


def split_site(html):
    """(head, body, script); head + body + script rebuilds the page."""
    i = html.lower().find("</head>")
    if i < 0:
        return None
    head, rest = html[: i + 7], html[i + 7:]
    scripts = re.findall(r"<script\b[\s\S]*?</script>", rest, re.I)
    body = re.sub(r"\s*<script\b[\s\S]*?</script>", "", rest, flags=re.I)
    body = re.sub(r"\s*</body>\s*</html>\s*$", "", body, flags=re.I).strip()
    script = "\n".join(scripts) + "\n</body>\n</html>"
    return head.strip(), body, script


def join_site(head, body, script):
    return f"{head}\n{body}\n{script}"


def part_examples(request, html):
    """Three chat examples, one per step (the request repeated, so each step stands alone)."""
    parts = split_site(html)
    if not parts:
        return []
    head, body, script = parts
    block = lambda s: f"```html\n{s}\n```"
    return [[{"role": "user", "content": request + STEP1}, {"role": "assistant", "content": block(head)}],
            [{"role": "user", "content": request + STEP2.format(head=head)}, {"role": "assistant", "content": block(body)}],
            [{"role": "user", "content": request + STEP3.format(body=body)}, {"role": "assistant", "content": block(script)}]]


if __name__ == "__main__":  # self-check on the real sites: the parts rebuild each page and every step fits the limit
    import json, sys
    from pathlib import Path
    root = Path(sys.argv[1])
    worst = 0
    for ex in json.loads((root / "examples.json").read_text(encoding="utf-8")):
        html = (root / ex["file"]).read_text(encoding="utf-8").strip()
        h, b, s = split_site(html)
        assert "<style" in h.lower() and "<body" in b.lower() and "<script" not in b.lower(), ex["file"]
        squash = lambda t: re.sub(r"\s+", "", t.lower())
        scripts = lambda t: re.findall(r"<script\b[\s\S]*?</script>", t, re.I)
        assert scripts(html) == scripts(h) + scripts(s), ex["file"]  # library tags in <head> stay with the design step
        nosc = lambda t: squash(re.sub(r"<script\b[\s\S]*?</script>", "", t, flags=re.I))
        assert nosc(join_site(h, b, s)) == nosc(html), ex["file"]
        for m in part_examples(ex["request"], html):
            worst = max(worst, len(m[0]["content"]) + len(m[1]["content"]))
    print("ok, longest step:", worst, "chars ≈", worst // 3, "tokens")
