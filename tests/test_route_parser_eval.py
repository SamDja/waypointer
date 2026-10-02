"""The route-parser eval harness (evals/route_parser/): that the case file
is well-formed and its expectations could actually be produced, and that the
scoring judges answers the way its docstring says."""

import importlib.util
import json
from pathlib import Path

import pytest

from waypointer import llm
from waypointer.route_request import ParsedRequest

EVAL_DIR = Path(__file__).parent.parent / "evals" / "route_parser"
_spec = importlib.util.spec_from_file_location("route_parser_eval", EVAL_DIR / "run.py")
run = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(run)

DATA = json.loads((EVAL_DIR / "cases.json").read_text())


def _plain(value):
    """An expected value as one concrete answer could hold it (the first
    any_of option, a contains list as the whole list)."""
    if isinstance(value, dict) and "any_of" in value:
        return _plain(value["any_of"][0])
    if isinstance(value, dict) and "contains" in value:
        return value["contains"]
    return value


def _answer_from(expected: dict) -> dict:
    """The nested ParsedRequest-shaped dict whose flattening is `expected`."""
    answer: dict = {}
    for field, value in expected.items():
        target = answer
        *parents, leaf = field.split(".")
        for part in parents:
            target = target.setdefault(part, {})
        target[leaf] = _plain(value)
    answer.setdefault("language", "en")
    return answer


def test_case_file_is_well_formed():
    ids = [c["id"] for c in DATA["cases"]]
    assert len(ids) == len(set(ids))
    assert 30 <= len(ids) <= 50
    assert set(DATA["defaults"]) == set(run.FIELDS) - {"language"}
    for case in DATA["cases"]:
        assert set(case["expected"]) <= set(run.FIELDS), case["id"]
        assert set(case.get("ignore", [])) <= set(run.FIELDS), case["id"]


@pytest.mark.parametrize("case", DATA["cases"], ids=lambda c: c["id"])
def test_every_expectation_is_a_valid_answer_that_scores_full_marks(case):
    expected = {**DATA["defaults"], **case["expected"]}
    answer = _answer_from(expected)
    # Fails if a case expects something the schema can't express.
    ParsedRequest.model_validate(answer)
    assert all(run.score_case(case, DATA["defaults"], answer).values())


@pytest.mark.parametrize(
    ("actual", "expected", "ok"),
    [
        ("Passo  Manghen", "passo manghen", True),
        ("Bozen", "Bolzano", False),
        ({"min": 72, "max": 88}, {"min": 72.0, "max": 88.0}, True),
        ({"min": 80, "max": 80}, {"min": 72, "max": 88}, False),
        ({"min": 64.4, "max": 64.4}, {"min": 64.36, "max": 64.36}, True),
        ({"min": None, "max": 1500}, {"min": 0, "max": 1500}, False),
        (None, {"min": 50, "max": 50}, False),
        ("loop", {"any_of": ["loop", None]}, True),
        (None, {"any_of": ["loop", None]}, True),
        (["start", "distance", "route_type"], {"contains": ["start", "distance"]}, True),
        (["start"], {"contains": ["start", "distance"]}, False),
        (8.0, 8, True),
        (True, 1, False),
    ],
)
def test_matches(actual, expected, ok):
    assert run.matches(actual, expected) is ok


def test_lists_are_sets_except_via():
    case = {"id": "x", "expected": {"language": "en", "via": ["A", "B"], "missing": ["start", "end"]}}
    answer = _answer_from({**DATA["defaults"], **case["expected"]})
    answer["missing"] = ["end", "start"]
    assert run.score_case(case, DATA["defaults"], answer)["missing"] is True
    answer["via"] = ["B", "A"]
    assert run.score_case(case, DATA["defaults"], answer)["via"] is False


def test_invented_values_cost_the_field_and_ignore_skips_it():
    case = {"id": "x", "expected": {"language": "en"}, "ignore": ["difficulty"]}
    answer = _answer_from({**DATA["defaults"], **case["expected"]})
    answer["ascent_m"] = {"min": 1000, "max": 1000}
    answer["difficulty"] = "hard"
    verdict = run.score_case(case, DATA["defaults"], answer)
    assert verdict["ascent_m"] is False
    assert "difficulty" not in verdict


def _fake_complete(content, cost=0.001):
    def complete(system, user, schema, name, spec):
        return llm.LlmResult(content, "served/model-001", "openrouter", 0.5, 10, 5, cost)

    return complete


def test_run_case_and_summary():
    case = next(c for c in DATA["cases"] if c["id"] == "en-no-zone")
    good = json.dumps(_answer_from({**DATA["defaults"], **case["expected"]}))
    rows = [
        run.run_case("openrouter:m", case, DATA["defaults"], complete=_fake_complete(good)),
        run.run_case("openrouter:m", case, DATA["defaults"], complete=_fake_complete("not json")),
    ]
    assert rows[0]["valid"] and all(rows[0]["fields"].values())
    assert not rows[1]["valid"] and not any(rows[1]["fields"].values())

    summary = run.summarize(rows)
    assert summary["valid_json_rate"] == 0.5
    assert summary["field_accuracy"] == 0.5
    assert summary["case_exact_rate"] == 0.5
    assert summary["cost_per_request_usd"] == pytest.approx(0.001)
    assert summary["served_models"] == ["served/model-001"]
    assert "openrouter:m" in run.markdown_table({"openrouter:m": summary})


def test_a_provider_error_is_recorded_not_raised():
    def failing(*_):
        raise llm.LlmError("down")

    case = DATA["cases"][0]
    row = run.run_case("openrouter:m", case, DATA["defaults"], complete=failing)
    assert row["error"] == "llm: down" and not row["valid"]


def test_rate_limits_are_retried_other_errors_are_not():
    attempts = []

    def flaky():
        attempts.append(1)
        if len(attempts) < 3:
            raise llm.LlmError("slow down", status=429)
        return "ok"

    assert run._with_retries(flaky, sleep=lambda _: None) == "ok"
    assert len(attempts) == 3

    def broken():
        attempts.append(1)
        raise llm.LlmError("boom", status=500)

    attempts.clear()
    with pytest.raises(llm.LlmError):
        run._with_retries(broken, sleep=lambda _: None)
    assert len(attempts) == 1
