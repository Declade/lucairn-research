#!/usr/bin/env python3
"""
compare-finance-summaries.py

Reads two SUMMARY.json outputs from analyze-finance-ndjson.ts (baseline + tuned)
and emits:
  - markdown table for the blog "Per-Category Δ" section
  - aggregate baseline-vs-tuned summary table
  - top FP delta (which FPs disappeared, which new FPs appeared)

Usage:
  python3 scripts/compare-finance-summaries.py \\
    --baseline papers/paper-2-finance/SUMMARY-baseline.json \\
    --tuned    papers/paper-2-finance/SUMMARY-tuned.json
"""

import argparse
import json
import sys


def pct(a, b):
    if b == 0:
        return None
    return round(a / b * 100, 1)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--baseline", required=True)
    p.add_argument("--tuned", required=True)
    args = p.parse_args()

    with open(args.baseline) as f:
        b = json.load(f)
    with open(args.tuned) as f:
        t = json.load(f)

    print("\n## Aggregate baseline vs tuned\n")
    print("| Metric | Baseline | After | Δ |")
    print("|---|---|---|---|")

    def row(label, bv, tv, fmt="{}", delta_fmt="{:+}"):
        if bv is None or tv is None:
            return f"| {label} | n/a | n/a | n/a |"
        delta = round(tv - bv, 2)
        return f"| {label} | {fmt.format(bv)} | **{fmt.format(tv)}** | {delta_fmt.format(delta)} |"

    print(f"| Rows OK | {b['rows_ok']} / 500 | **{t['rows_ok']} / 500** | {t['rows_ok']-b['rows_ok']:+} |")
    print(f"| TP | {b['aggregate']['tp_total']} | **{t['aggregate']['tp_total']}** | {t['aggregate']['tp_total']-b['aggregate']['tp_total']:+} |")
    print(f"| FN | {b['aggregate']['fn_total']} | **{t['aggregate']['fn_total']}** | {t['aggregate']['fn_total']-b['aggregate']['fn_total']:+} |")
    print(f"| FP | {b['aggregate']['fp_total']} | **{t['aggregate']['fp_total']}** | {t['aggregate']['fp_total']-b['aggregate']['fp_total']:+} ({round((t['aggregate']['fp_total']-b['aggregate']['fp_total'])/max(b['aggregate']['fp_total'],1)*100, 1):+}%) |")
    print(f"| Recall | {b['aggregate']['recall']} % | **{t['aggregate']['recall']} %** | {round(t['aggregate']['recall']-b['aggregate']['recall'], 1):+} pp |")
    print(f"| Precision | {b['aggregate']['precision']} % | **{t['aggregate']['precision']} %** | {round(t['aggregate']['precision']-b['aggregate']['precision'], 1):+} pp |")
    print(f"| F1 | {b['aggregate']['f1']} | **{t['aggregate']['f1']}** | {round(t['aggregate']['f1']-b['aggregate']['f1'], 1):+} pp |")

    print("\n## Per-category recall delta (sorted by largest absolute gain)\n")
    print("| Category | Baseline | After | Δ |")
    print("|---|---|---|---|")

    b_by_cat = {row["category"]: row for row in b["per_category"]}
    t_by_cat = {row["category"]: row for row in t["per_category"]}
    rows = []
    for cat, b_row in b_by_cat.items():
        if cat == "UNMAPPED":
            continue
        t_row = t_by_cat.get(cat)
        if t_row is None:
            continue
        br = b_row["recall"]
        tr = t_row["recall"]
        if br is None or tr is None:
            continue
        rows.append((cat, br, tr, round(tr - br, 1)))
    rows.sort(key=lambda x: -abs(x[3]))
    for cat, br, tr, delta in rows:
        bold = "**" if abs(delta) >= 5 else ""
        print(f"| {bold}{cat}{bold} | {br} % | {bold}{tr} %{bold} | {bold}{delta:+} pp{bold} |")

    print("\n## Wall-clock\n")
    bwc = b["wall_clock"]["duration_ms"]
    twc = t["wall_clock"]["duration_ms"]
    if bwc and twc:
        bw_min = round(bwc / 60000, 1)
        tw_min = round(twc / 60000, 1)
        delta_pct = round((twc - bwc) / bwc * 100, 1)
        print(f"Baseline: {bw_min} min ({bwc} ms)")
        print(f"After:    {tw_min} min ({twc} ms)")
        print(f"Δ:        {delta_pct:+}%")

    print("\n## Top FP value delta\n")
    b_fps = {e["value"]: e["count"] for e in b["top_extras"]}
    t_fps = {e["value"]: e["count"] for e in t["top_extras"]}
    all_vals = set(b_fps) | set(t_fps)
    changes = []
    for v in all_vals:
        bc = b_fps.get(v, 0)
        tc = t_fps.get(v, 0)
        changes.append((v, bc, tc, tc - bc))
    changes.sort(key=lambda x: -abs(x[3]))
    print("```")
    print(f"{'value':<60} baseline   after    Δ")
    for v, bc, tc, delta in changes[:25]:
        print(f"{v[:60]:<60} {bc:>8}   {tc:>5}   {delta:+}")
    print("```")


if __name__ == "__main__":
    main()
