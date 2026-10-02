"""A thin client in front of whichever LLM parses natural-language route
requests (route_request.py).

Every provider worth trying speaks the OpenAI-compatible chat completions API
(OpenRouter, Ollama local and cloud, OpenAI itself), so one client covers them
all and the model is chosen by config: a model spec is "<provider>:<model>",
e.g. "openrouter:google/gemini-2.5-flash" or "ollama_cloud:gpt-oss:120b".
`NL_PARSER_MODEL` (runtime env) names the default.

Plain `requests`, not LiteLLM or a vendor SDK: we need one call shape, and the
model is meant to be swapped by config rather than by code.

The model a provider *actually* served (it may resolve an alias to a dated
version) is logged with every request, as the card requires, and returned on
the result so the eval can record it too.
"""

import logging
import os
import time
from dataclasses import dataclass

import requests

from waypointer.routing import USER_AGENT

logger = logging.getLogger(__name__)

# Chosen on evals/route_parser/ (2026-10-02): the most accurate of eight
# models compared, and the only one that never followed an injected
# instruction. openrouter:google/gemini-2.5-flash came a close second and is
# the fallback to switch to if Ollama Cloud's plan limits get in the way.
DEFAULT_MODEL_SPEC = os.environ.get("NL_PARSER_MODEL", "ollama_cloud:gemma4:31b")
REQUEST_TIMEOUT_S = 60


@dataclass(frozen=True)
class Provider:
    base_url: str
    # Env var holding the API key; None for a provider that needs none
    # (local Ollama).
    key_env: str | None
    # Whether the provider accepts `response_format: json_schema`. Those that
    # don't get `json_object` plus the schema in the prompt.
    json_schema: bool = True


PROVIDERS: dict[str, Provider] = {
    "openrouter": Provider("https://openrouter.ai/api/v1", "OPENROUTER_API_KEY"),
    "ollama_cloud": Provider(
        os.environ.get("OLLAMA_CLOUD_URL", "https://ollama.com/v1"), "OLLAMA_API_KEY"
    ),
    "ollama": Provider(os.environ.get("OLLAMA_URL", "http://localhost:11434/v1"), None),
    "openai": Provider("https://api.openai.com/v1", "OPENAI_API_KEY"),
}


class LlmError(RuntimeError):
    """The provider failed, refused, or answered with no content."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        # The provider's HTTP status when it answered with an error, so a
        # caller can tell "slow down" (429) from "broken".
        self.status = status


class LlmNotConfiguredError(LlmError):
    """Unknown provider, or its API key isn't set."""


@dataclass(frozen=True)
class LlmResult:
    content: str
    # The model the provider reports having served, which can be more
    # specific than the one asked for.
    model: str
    provider: str
    latency_s: float
    prompt_tokens: int | None
    completion_tokens: int | None
    # What the call cost in USD, when the provider says (OpenRouter does);
    # None otherwise.
    cost_usd: float | None


def split_model_spec(spec: str) -> tuple[str, str]:
    """ "openrouter:google/gemini-2.5-flash" -> ("openrouter", "google/gemini-2.5-flash").
    Only the first colon splits, since Ollama tags carry one ("gpt-oss:120b")."""
    provider, sep, model = spec.partition(":")
    if not sep or not model or provider not in PROVIDERS:
        known = ", ".join(PROVIDERS)
        raise LlmNotConfiguredError(f"Model spec must be '<provider>:<model>' with provider one of {known}: {spec!r}")
    return provider, model


def api_key(provider_key: str) -> str | None:
    """The provider's API key, None for one that needs none; raises
    LlmNotConfiguredError when it needs one that isn't set."""
    provider = PROVIDERS[provider_key]
    if not provider.key_env:
        return None
    key = os.environ.get(provider.key_env)
    if not key:
        raise LlmNotConfiguredError(f"{provider.key_env} is not set.")
    return key


def complete_json(
    system: str,
    user: str,
    schema: dict,
    schema_name: str,
    model_spec: str = DEFAULT_MODEL_SPEC,
    session: requests.Session | None = None,
    temperature: float = 0.0,
) -> LlmResult:
    """One chat completion constrained to JSON, returning the raw content.

    The caller validates the content against its own schema - a provider's
    structured-output support varies by model, so it's a hint, not a promise.
    """
    provider_key, model = split_model_spec(model_spec)
    provider = PROVIDERS[provider_key]
    headers = {"User-Agent": USER_AGENT, "Content-Type": "application/json"}
    key = api_key(provider_key)
    if key:
        headers["Authorization"] = f"Bearer {key}"

    if provider.json_schema:
        response_format = {
            "type": "json_schema",
            "json_schema": {"name": schema_name, "strict": True, "schema": schema},
        }
    else:
        response_format = {"type": "json_object"}
    body: dict = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": temperature,
        "response_format": response_format,
    }
    if provider_key == "openrouter":
        # Have OpenRouter report what the call cost.
        body["usage"] = {"include": True}

    http = session or requests
    started = time.monotonic()
    try:
        response = http.post(
            f"{provider.base_url}/chat/completions", json=body, headers=headers, timeout=REQUEST_TIMEOUT_S
        )
    except requests.RequestException as exc:
        raise LlmError(f"{provider_key} request failed: {exc}") from exc
    latency = time.monotonic() - started
    if response.status_code != 200:
        raise LlmError(
            f"{provider_key} returned status {response.status_code}: {response.text[:300]}", status=response.status_code
        )
    try:
        data = response.json()
        choice = data["choices"][0]
        content = choice["message"].get("content")
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise LlmError(f"{provider_key} returned malformed data: {exc}") from exc
    if not content:
        raise LlmError(f"{provider_key} returned no content (finish_reason={choice.get('finish_reason')!r}).")

    usage = data.get("usage") or {}
    served = str(data.get("model") or model)
    result = LlmResult(
        content=content,
        model=served,
        provider=provider_key,
        latency_s=latency,
        prompt_tokens=usage.get("prompt_tokens"),
        completion_tokens=usage.get("completion_tokens"),
        cost_usd=float(usage["cost"]) if isinstance(usage.get("cost"), (int, float)) else None,
    )
    logger.info(
        "llm call provider=%s requested=%s served=%s fingerprint=%s latency=%.2fs tokens=%s/%s cost=%s",
        provider_key,
        model,
        served,
        data.get("system_fingerprint"),
        latency,
        result.prompt_tokens,
        result.completion_tokens,
        result.cost_usd,
    )
    return result
