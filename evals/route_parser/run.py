"""Run every model on the route-parser eval set and compare them.

    uv run --env-file .env python evals/route_parser/run.py \\
        --model openrouter:google/gemini-2.5-flash \\
        --model ollama_cloud:gpt-oss:120b --runs 2 --max-usd 1

Reports, per model: valid-JSON rate (an answer that parses into
route_request.ParsedRequest), field-level accuracy, the share of cases with
every field right, latency (mean and p95) and cost per request. Every
answer, with its per-field verdict, goes to results/<timestamp>.json.

Scoring: each case's expected values are `defaults` overridden by the
case's own, so a model inventing a value nobody asked for loses the field.
Fields named in a case's `ignore` aren't scored (genuinely open readings).
An answer that isn't valid counts as every field wrong.

Matchers in an expected value:
- a plain value: equal after normalising (case, accents, spacing); a range
  {min, max} matches when each bound is within RANGE_TOLERANCE of the
  expected one (both null counts as equal);
- {"any_of": [...]}: any one of these;
- {"contains": [...]}: a list holding at least these.

`--max-usd` stops the run once the reported spend reaches it. Only
OpenRouter reports cost; for others the column says n/a and the cap can't
apply, so keep runs small there.
"""

import argparse
import json
import statistics
import sys
import time
import unicodedata
from datetime import datetime
from pathlib import Path

from waypointer import llm
from waypointer.route_request import ParseError, build_messages, parsed_schema, validate_content

HERE = Path(__file__).parent
RANGE_TOLERANCE = 0.1
# Below this an absolute difference is fine whatever the relative one
# (64.4 km for 40 miles is close enough to 64.36).
RANGE_ABS_TOLERANCE = 0.5

FIELDS = (
    "out_of_scope",
    "language",
    "sport",
    "route_type",
    "start",
    "end",
    "via",
    "distance_km",
    "ascent_m",
    "duration_h",
    "max_gradient_pct",
    "difficulty",
    "climbs.categories",
    "climbs.named",
    "avoid.places",
    "avoid.road_types",
    "avoid.surfaces",
    "missing",
)


def _norm(value):
    if isinstance(value, str):
        decomposed = unicodedata.normalize("NFKD", value.casefold())
        return " ".join("".join(c for c in decomposed if not unicodedata.combining(c)).split())
    if isinstance(value, list):
        return [_norm(v) for v in value]
    return value


def _close(actual, expected) -> bool:
    if expected is None or actual is None:
        return expected is None and actual is None
    return abs(actual - expected) <= max(RANGE_ABS_TOLERANCE, RANGE_TOLERANCE * abs(expected))


def _is_range(value) -> bool:
    return isinstance(value, dict) and set(value) == {"min", "max"}


def matches(actual, expected) -> bool:
    if isinstance(expected, dict) and "any_of" in expected:
        return any(matches(actual, option) for option in expected["any_of"])
    if isinstance(expected, dict) and "contains" in expected:
        return isinstance(actual, list) and all(_norm(e) in _norm(actual) for e in expected["contains"])
    if _is_range(expected):
        return _is_range(actual) and _close(actual["min"], expected["min"]) and _close(actual["max"], expected["max"])
    if isinstance(expected, (int, float)) and not isinstance(expected, bool):
        return isinstance(actual, (int, float)) and not isinstance(actual, bool) and _close(actual, expected)
    return _norm(actual) == _norm(expected)


def flatten(parsed: dict) -> dict:
    flat = {}
    for field in FIELDS:
        value = parsed
        for part in field.split("."):
            value = value.get(part) if isinstance(value, dict) else None
        flat[field] = value
    return flat


def _sorted_unless_ordered(field: str, value):
    # Order matters only for via (it's the order to ride them in); every
    # other list is a set.
    if field != "via" and isinstance(value, list) and all(isinstance(v, str) for v in value):
        return sorted(_norm(value))
    return value


def score_case(case: dict, defaults: dict, parsed: dict | None) -> dict[str, bool]:
    """Field -> right or wrong, for the fields this case scores."""
    expected = {**defaults, **case["expected"]}
    scored = [f for f in FIELDS if f not in case.get("ignore", [])]
    if parsed is None:
        return {f: False for f in scored}
    flat = flatten(parsed)
    verdict = {}
    for f in scored:
        exp = expected[f]
        if isinstance(exp, list):
            verdict[f] = matches(_sorted_unless_ordered(f, flat[f]), _sorted_unless_ordered(f, exp))
        else:
            verdict[f] = matches(flat[f], exp)
    return verdict


def summarize(rows: list[dict]) -> dict:
    """Aggregate one model's rows (one per case per run)."""
    n = len(rows)
    valid = [r for r in rows if r["valid"]]
    fields = [ok for r in rows for ok in r["fields"].values()]
    latencies = sorted(r["latency_s"] for r in rows if r["latency_s"] is not None)
    costs = [r["cost_usd"] for r in rows if r["cost_usd"] is not None]
    return {
        "requests": n,
        "valid_json_rate": len(valid) / n if n else 0.0,
        "field_accuracy": sum(fields) / len(fields) if fields else 0.0,
        "case_exact_rate": sum(1 for r in rows if r["fields"] and all(r["fields"].values())) / n if n else 0.0,
        "latency_mean_s": statistics.fmean(latencies) if latencies else None,
        "latency_p95_s": latencies[min(len(latencies) - 1, int(0.95 * len(latencies)))] if latencies else None,
        "cost_per_request_usd": sum(costs) / len(costs) if costs else None,
        "cost_total_usd": sum(costs) if costs else None,
        "served_models": sorted({r["served_model"] for r in rows if r["served_model"]}),
    }


def _fmt(value, pattern):
    return "n/a" if value is None else pattern.format(value)


def markdown_table(summaries: dict[str, dict]) -> str:
    lines = [
        "| Model | Valid JSON | Field accuracy | All fields right | Latency mean / p95 | Cost / request |",
        "|---|---|---|---|---|---|",
    ]
    for spec, s in sorted(summaries.items(), key=lambda kv: -kv[1]["field_accuracy"]):
        lines.append(
            f"| {spec} | {s['valid_json_rate']:.0%} | {s['field_accuracy']:.1%} | {s['case_exact_rate']:.0%} "
            f"| {_fmt(s['latency_mean_s'], '{:.1f}s')} / {_fmt(s['latency_p95_s'], '{:.1f}s')} "
            f"| {_fmt(s['cost_per_request_usd'], '${:.5f}')} |"
        )
    return "\n".join(lines)


# A 429 is the provider (or the one behind OpenRouter) asking us to slow
# down, not a verdict on the model, so it's retried rather than scored.
RETRY_DELAYS_S = (5, 15, 45)


def _with_retries(call, sleep=time.sleep):
    for delay in RETRY_DELAYS_S:
        try:
            return call()
        except llm.LlmError as exc:
            if exc.status != 429:
                raise
            sleep(delay)
    return call()


def run_case(spec: str, case: dict, defaults: dict, complete=llm.complete_json) -> dict:
    system, user = build_messages(case["prompt"])
    row = {"case": case["id"], "model": spec, "valid": False, "error": None, "answer": None,
           "served_model": None, "latency_s": None, "cost_usd": None, "tokens": None}
    parsed = None
    try:
        result = _with_retries(lambda: complete(system, user, parsed_schema(), "route_request", spec))
    except llm.LlmError as exc:
        row["error"] = f"llm: {exc}"
    else:
        row.update(served_model=result.model, latency_s=result.latency_s, cost_usd=result.cost_usd,
                   tokens=[result.prompt_tokens, result.completion_tokens], answer=result.content)
        try:
            parsed = validate_content(result.content).model_dump()
            row["valid"] = True
        except ParseError as exc:
            row["error"] = f"invalid: {str(exc)[:500]}"
    row["fields"] = score_case(case, defaults, parsed)
    return row


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", action="append", required=True, help="<provider>:<model>, repeatable")
    parser.add_argument("--cases", type=Path, default=HERE / "cases.json")
    parser.add_argument("--only", action="append", help="run only these case ids (repeatable)")
    parser.add_argument("--runs", type=int, default=1, help="times each case is asked, for consistency")
    parser.add_argument("--max-usd", type=float, default=1.0, help="stop once reported spend reaches this")
    parser.add_argument("--out", type=Path, default=HERE / "results")
    args = parser.parse_args(argv)

    data = json.loads(args.cases.read_text())
    cases = [c for c in data["cases"] if not args.only or c["id"] in args.only]
    # Fail fast on a typo or a missing key, rather than once per case.
    for spec in args.model:
        llm.api_key(llm.split_model_spec(spec)[0])
    rows_by_model: dict[str, list[dict]] = {spec: [] for spec in args.model}
    spent = 0.0
    stopped = False
    for spec in args.model:
        for run in range(args.runs):
            for case in cases:
                if spent >= args.max_usd:
                    stopped = True
                    break
                row = run_case(spec, case, data["defaults"])
                row["run"] = run
                rows_by_model[spec].append(row)
                spent += row["cost_usd"] or 0.0
                wrong = [f for f, ok in row["fields"].items() if not ok]
                status = "ok" if not wrong else ("ERR " + row["error"][:80] if row["error"] else f"wrong: {', '.join(wrong)}")
                print(f"[{spec}] {case['id']}: {status}", file=sys.stderr)

    summaries = {spec: summarize(rows) for spec, rows in rows_by_model.items() if rows}
    args.out.mkdir(parents=True, exist_ok=True)
    out = args.out / f"{datetime.now():%Y%m%d-%H%M%S}.json"
    out.write_text(json.dumps({"summaries": summaries, "rows": rows_by_model, "spent_usd": spent,
                               "stopped_on_budget": stopped, "at": time.time()}, indent=1, ensure_ascii=False))
    print(markdown_table(summaries))
    print(f"\nSpent ${spent:.4f} (reported).{' Stopped at the --max-usd cap.' if stopped else ''} Details: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
