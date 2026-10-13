"""Explicit source-selection protocol; never repairs generated memory prose."""
from .errors import DomainError
from .memory_policy import direct_fact_content
from .memory_temporal import allowed_metadata


def source_units(sources):
    """One complete user message per unit; no semantic sentence splitting."""
    units = []
    for source in sources:
        content = direct_fact_content(source["content"])
        if source["role"] != "user" or not content or len(content) > 1000 or len(source["content"]) > 2000:
            continue  # No truncation to manufacture a selectable fact.
        units.append({"unit_id": "user:" + source["message_id"], "message_id": source["message_id"],
                      "content": content, "quote": source["content"], "allowed_metadata": allowed_metadata(source)})
    return units


def materialize(result, units):
    """Schema-valid raw entries map 1:1, in order, to canonical candidates."""
    indexed = {u["unit_id"]: u for u in units}
    candidates = []
    for candidate in result["candidates"]:
        if candidate["evidence_kind"] == "agent_inference":
            candidates.append(dict(candidate))
            continue
        unit = indexed.get(candidate["source_unit_id"])
        if unit is None:
            raise DomainError("InvalidSource", "Selected unit is outside the completed user turn")
        candidates.append({k: v for k, v in candidate.items() if k != "source_unit_id"} | {
            "content": unit["content"], "source_message_ids": [unit["message_id"]],
            "sources": [{"message_id": unit["message_id"], "quote": unit["quote"]}]})
    return {"candidates": candidates}
