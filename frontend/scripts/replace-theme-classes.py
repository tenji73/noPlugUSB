#!/usr/bin/env python3
"""One-off semantic theme migration: slate-* → app-* in templates."""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1] / "src"

# Order: longer / more specific first.
REPL = [
    ("border-slate-800/90", "border-app-border/90"),
    ("border-slate-800/70", "border-app-border/70"),
    ("border-slate-700/90", "border-app-border-soft/90"),
    ("border-slate-700/80", "border-app-border-soft/80"),
    ("border-slate-700/70", "border-app-border-soft/70"),
    ("border-slate-600/80", "border-app-border-soft/80"),
    ("ring-slate-800/90", "ring-app-border/90"),
    ("ring-slate-700/15", "ring-app-border-soft/15"),
    ("bg-slate-900/95", "bg-app-surface/95"),
    ("bg-slate-900/80", "bg-app-surface/80"),
    ("bg-slate-900/60", "bg-app-surface/60"),
    ("bg-slate-800/90", "bg-app-raised/90"),
    ("bg-slate-800/80", "bg-app-raised/80"),
    ("bg-slate-800/70", "bg-app-raised/70"),
    ("from-slate-800/90", "from-app-raised/90"),
    ("from-slate-800", "from-app-raised"),
    ("to-slate-950", "to-app-page"),
    ("via-slate-100", "via-app-subtle"),
    ("text-slate-50/95", "text-app-fg/95"),
    ("bg-slate-950", "bg-app-page"),
    ("bg-slate-900", "bg-app-surface"),
    ("bg-slate-800", "bg-app-raised"),
    ("border-slate-800", "border-app-border"),
    ("border-slate-700", "border-app-border-soft"),
    ("border-slate-600", "border-app-border-soft"),
    ("ring-slate-800", "ring-app-border"),
    ("ring-slate-700", "ring-app-border-soft"),
    ("divide-slate-800", "divide-app-border"),
    ("divide-slate-700", "divide-app-border-soft"),
    ("placeholder:text-slate-600", "placeholder:text-app-muted"),
    ("placeholder:text-slate-500", "placeholder:text-app-muted"),
    ("text-slate-50", "text-app-fg"),
    ("text-slate-100", "text-app-fg"),
    ("text-slate-200", "text-app-fg"),
    ("text-slate-300", "text-app-subtle"),
    ("text-slate-400", "text-app-muted"),
    ("text-slate-500", "text-app-muted"),
    ("text-slate-600", "text-app-muted"),
]

def main() -> None:
    for path in sorted(ROOT.rglob("*.html")):
        text = path.read_text(encoding="utf-8")
        orig = text
        for a, b in REPL:
            text = text.replace(a, b)
        if text != orig:
            path.write_text(text, encoding="utf-8")
            print("updated:", path.relative_to(ROOT.parent.parent))

if __name__ == "__main__":
    main()
