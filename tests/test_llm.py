"""The provider-agnostic LLM client (llm.py), against a mocked
OpenAI-compatible endpoint."""

import json

import pytest
import responses

from waypointer import llm

OPENROUTER = "https://openrouter.ai/api/v1/chat/completions"


def _completion(content='{"ok": true}', model="google/gemini-2.5-flash-001", usage=None):
    return {
        "model": model,
        "choices": [{"message": {"content": content}, "finish_reason": "stop"}],
        "usage": usage if usage is not None else {"prompt_tokens": 100, "completion_tokens": 20, "cost": 0.00012},
    }


@pytest.fixture
def openrouter_key(monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")


@pytest.mark.parametrize(
    ("spec", "expected"),
    [
        ("openrouter:google/gemini-2.5-flash", ("openrouter", "google/gemini-2.5-flash")),
        # Ollama tags carry a colon of their own.
        ("ollama_cloud:gpt-oss:120b", ("ollama_cloud", "gpt-oss:120b")),
    ],
)
def test_split_model_spec(spec, expected):
    assert llm.split_model_spec(spec) == expected


@pytest.mark.parametrize("spec", ["gemini", "nope:model", "openrouter:"])
def test_split_model_spec_rejects_bad_specs(spec):
    with pytest.raises(llm.LlmNotConfiguredError):
        llm.split_model_spec(spec)


@responses.activate
def test_sends_schema_key_and_reports_served_model_and_cost(openrouter_key):
    responses.add(responses.POST, OPENROUTER, json=_completion(), status=200)
    result = llm.complete_json("sys", "user", {"type": "object"}, "thing", "openrouter:google/gemini-2.5-flash")

    request = responses.calls[0].request
    body = json.loads(request.body)
    assert request.headers["Authorization"] == "Bearer test-key"
    assert body["model"] == "google/gemini-2.5-flash"
    assert body["response_format"]["type"] == "json_schema"
    assert body["response_format"]["json_schema"]["schema"] == {"type": "object"}
    assert body["usage"] == {"include": True}
    assert [m["role"] for m in body["messages"]] == ["system", "user"]

    assert result.content == '{"ok": true}'
    assert result.model == "google/gemini-2.5-flash-001"
    assert result.cost_usd == pytest.approx(0.00012)
    assert (result.prompt_tokens, result.completion_tokens) == (100, 20)


@responses.activate
def test_local_ollama_needs_no_key_and_has_no_cost():
    responses.add(
        responses.POST,
        "http://localhost:11434/v1/chat/completions",
        json=_completion(usage={"prompt_tokens": 5, "completion_tokens": 1}),
        status=200,
    )
    result = llm.complete_json("s", "u", {}, "t", "ollama:qwen3:8b")
    assert "Authorization" not in responses.calls[0].request.headers
    assert "usage" not in json.loads(responses.calls[0].request.body)
    assert result.cost_usd is None


def test_missing_key_is_not_configured(monkeypatch):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    with pytest.raises(llm.LlmNotConfiguredError):
        llm.complete_json("s", "u", {}, "t", "openrouter:any/model")


@responses.activate
@pytest.mark.parametrize(
    "kwargs",
    [
        {"status": 500, "body": "boom"},
        {"status": 200, "body": "not json"},
        {"status": 200, "json": {"choices": []}},
        {"status": 200, "json": {"choices": [{"message": {"content": None}, "finish_reason": "content_filter"}]}},
    ],
)
def test_failures_raise_llm_error(openrouter_key, kwargs):
    responses.add(responses.POST, OPENROUTER, **kwargs)
    with pytest.raises(llm.LlmError):
        llm.complete_json("s", "u", {}, "t", "openrouter:any/model")
