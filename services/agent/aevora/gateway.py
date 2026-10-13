"""One explicit OpenAI-compatible dialect; no implicit retries or fallback."""
import asyncio
import json
import time
from urllib.parse import urlsplit

import httpx

from .errors import DomainError


class ModelGateway:
    def __init__(self, config=None):
        self.configure(config)

    def configure(self, config):
        if config:
            parsed = urlsplit(config.get("base_url", ""))
            if (parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in
                    ("127.0.0.1", "localhost", "::1"))) or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise DomainError("ValidationError", "Provider requires HTTPS or explicit loopback HTTP")
            if not config.get("model") or "," in config["model"]:
                raise DomainError("ValidationError", "Configure exactly one model")
            if config.get("dialect") != "openai-compatible":
                raise DomainError("ValidationError", "Unsupported API dialect")
            if not (512 <= config.get("max_input_tokens", 0) <= 32768 and
                    32 <= config.get("max_output_tokens", 0) <= 4096):
                raise DomainError("ValidationError", "Invalid token budget")
        self.config = config or {}

    def ready(self):
        if not self.config.get("api_key") or not self.config.get("chat_allowed"):
            raise DomainError("ProviderUnavailable", "Configure a Provider and allow Chat outbound first")
        return dict(self.config)

    def public(self):
        return {k: v for k, v in self.config.items() if k not in ("api_key", "extraction", "embedding", "selection")} | {
            "credential_present": bool(self.config.get("api_key"))}

    async def stream(self, config, messages, consume, metadata, *, response_format=None):
        began = time.monotonic()
        payload = {"model": config["model"], "messages": messages, "stream": True,
                   "stream_options": {"include_usage": True}, "max_tokens": config["max_output_tokens"]}
        if response_format is not None:
            if response_format != {"type": "json_object"}:
                raise DomainError("ValidationError", "Unsupported structured output mode")
            payload["response_format"] = response_format
        # A named, measured provider profile rather than sending vendor fields to every dialect.
        if config.get("profile") == "dashscope":
            payload["enable_thinking"] = False
        url = config["base_url"].rstrip("/") + "/chat/completions"
        idle_seconds = config.get("idle_timeout_seconds", 30)
        # SSE comments, role-only deltas and reasoning must not keep Chat alive.
        # The deadline below measures usable output, independently of socket reads.
        timeout = httpx.Timeout(idle_seconds, connect=10, read=None)
        metadata.update(request_id=None, response_id=None, usage=None, finish_reason=None)
        done = False
        async with asyncio.timeout(config.get("total_timeout_seconds", 120)), asyncio.timeout(idle_seconds) as progress:
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False) as client:
                async with client.stream("POST", url, headers={"Authorization": "Bearer " + config["api_key"]},
                                         json=payload) as response:
                    metadata["http_status"] = response.status_code
                    metadata["request_id"] = response.headers.get("x-request-id") or response.headers.get("request-id")
                    if response.status_code != 200:
                        # Do not include arbitrary server bodies: they may echo private inputs or credentials.
                        raise DomainError("ProviderUnavailable", f"Provider HTTP {response.status_code}")
                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        raw = line[5:].strip()
                        if raw == "[DONE]":
                            done = True
                            break
                        try:
                            chunk = json.loads(raw)
                        except ValueError:
                            raise DomainError("ProviderProtocolError", "Malformed SSE data") from None
                        if chunk.get("error"):
                            raise DomainError("ProviderUnavailable", "Provider rejected streaming request")
                        metadata["response_id"] = chunk.get("id") or metadata["response_id"]
                        metadata["model_returned"] = chunk.get("model") or metadata.get("model_returned")
                        if chunk.get("usage"):
                            metadata["usage"] = chunk["usage"]
                        for choice in chunk.get("choices", []):
                            if choice.get("index", 0) != 0:
                                continue
                            delta = choice.get("delta", {})
                            if delta.get("tool_calls"):
                                raise DomainError("ProviderProtocolError", "Tools are not enabled in G2")
                            # Private reasoning is never persisted or broadcast.
                            text = delta.get("content") or ""
                            if not isinstance(text, str):
                                raise DomainError("ProviderProtocolError", "Expected text delta")
                            if text:
                                metadata.setdefault("first_output_seconds", round(time.monotonic() - began, 3))
                                consume(text)
                                progress.reschedule(asyncio.get_running_loop().time() + idle_seconds)
                            if choice.get("finish_reason"):
                                metadata["finish_reason"] = choice["finish_reason"]
        metadata["elapsed_seconds"] = round(time.monotonic() - began, 3)
        if not done or not metadata["finish_reason"]:
            raise DomainError("StreamInterrupted", "Provider stream ended without a terminal marker")


class EmbeddingGateway(ModelGateway):
    """Purpose-specific adapter behind the same gateway boundary; no fallback/retry."""
    def configure(self, config):
        super().configure(config)
        if config and (not isinstance(config.get("dimensions"), int) or not 1 <= config["dimensions"] <= 2048
                or not isinstance(config.get("embedding_allowed"), bool)
                or not isinstance(config.get("max_calls"), int) or not 1 <= config["max_calls"] <= 1000
                or not isinstance(config.get("max_total_input_tokens"), int) or not 512 <= config["max_total_input_tokens"] <= 1_000_000):
            raise DomainError("ValidationError", "Invalid Embedding purpose, dimensions or budget")
    async def embed(self, config, text, metadata):
        import math
        began = time.monotonic()
        async with asyncio.timeout(config.get("total_timeout_seconds", 120)):
            async with httpx.AsyncClient(timeout=httpx.Timeout(30, connect=10), follow_redirects=False, trust_env=False) as client:
                response = await client.post(config["base_url"].rstrip("/") + "/embeddings",
                    headers={"Authorization": "Bearer " + config["api_key"]},
                    json={"model": config["model"], "input": [text], "dimensions": config["dimensions"], "encoding_format": "float"})
        metadata.update(http_status=response.status_code, request_id=response.headers.get("x-request-id"),
                        elapsed_seconds=round(time.monotonic() - began, 4))
        if response.status_code != 200:
            raise DomainError("ProviderUnavailable", f"Embedding HTTP {response.status_code}")
        try:
            value = response.json()
            data = value["data"]
            if len(data) != 1 or data[0].get("index") != 0:
                raise ValueError()
            vector = data[0]["embedding"]
            if not isinstance(vector, list) or len(vector) != config["dimensions"] or any(
                    isinstance(x, bool) or not isinstance(x, (float, int)) or not math.isfinite(x) for x in vector):
                raise ValueError()
            if sum(x*x for x in vector) <= 0:
                raise ValueError()
            metadata.update(model_returned=value.get("model"), usage=value.get("usage"))
            return vector
        except (ValueError, KeyError, TypeError):
            raise DomainError("ProviderProtocolError", "Invalid embedding response; nothing indexed") from None
