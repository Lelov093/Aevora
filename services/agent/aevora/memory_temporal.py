"""Bounded source-supported validity, not a general event-time interpreter.

Validity is [valid_from, valid_until). A date-only end includes that local day;
an explicitly supplied clock end is the exclusive boundary. Event dates alone
never establish validity. P0 uses a trusted Shanghai input timezone snapshot.
"""
import re
from datetime import date, datetime, time, timedelta, timezone

from .errors import DomainError
from .memory_policy import normalized, user_fact

VERSION = "memory-temporal-v1"
INPUT_TIMEZONE = "Asia/Shanghai"
FIELDS = ("valid_from", "valid_until", "scope")
_OFFSET = re.compile(r"^([+-])(\d{2}):(\d{2})$")
_TOKEN = r"(?:\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?)?|今天|明天|后天)"
_RANGE = re.compile(rf"^有效期为\s*(?P<start>{_TOKEN})\s*至\s*(?P<end>{_TOKEN})$")
_START = re.compile(rf"^有效期从\s*(?P<start>{_TOKEN})\s*开始$")
_END = re.compile(rf"^有效期至\s*(?P<end>{_TOKEN})$")
_SCOPE = re.compile(r"^仅适用于(?P<scope>[^。；;！？!?\n]{1,80})$")
_INDIRECT = re.compile(r'["“”‘’`]|引用|转述|第三方|他说|她说|别人|虚构|假设|如果|也许|可能|据说|不代表|不要记|别记|不保存')
_TEMPORARY = re.compile(r"今天|明天|后天|最近|暂时|本次|这次|这两天|有效期|仅适用于")


def input_zone(name):
    # Deliberately bounded P0 configuration. Unknown zones are never guessed
    # from the machine timezone or extraction execution time.
    if name == INPUT_TIMEZONE:
        return timezone(timedelta(hours=8), INPUT_TIMEZONE)
    if name in ("UTC", "Etc/UTC"):
        return timezone.utc
    match = _OFFSET.fullmatch(name or "")
    if match and int(match[2]) <= 14 and int(match[3]) < 60 and (int(match[2]) < 14 or int(match[3]) == 0):
        minutes = (int(match[2]) * 60 + int(match[3])) * (1 if match[1] == "+" else -1)
        return timezone(timedelta(minutes=minutes))
    raise DomainError("InvalidTemporalMetadata", "Input timezone is unknown or unsupported; no time boundary can be inferred")


def aware(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("Missing timezone")
        return parsed
    except (ValueError, TypeError, AttributeError) as exc:
        raise DomainError("InvalidTemporalMetadata", "Validity must be an explicit timezone-aware timestamp") from exc


def boundary(token, source, end=False):
    if "T" in token:
        parsed = datetime.fromisoformat(token.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=input_zone(source.get("source_timezone")))
        return parsed.astimezone(timezone.utc), "clock"
    zone = input_zone(source.get("source_timezone"))
    if token in ("今天", "明天", "后天"):
        day = aware(source["created_at"]).astimezone(zone).date() + timedelta(days=("今天", "明天", "后天").index(token))
    else:
        day = date.fromisoformat(token)
    if end:
        day += timedelta(days=1)
    return datetime.combine(day, time.min, zone).astimezone(timezone.utc), "day"


def explicit_fields(source):
    """Read explicit clauses; shared by request guidance and output validation."""
    fact, _ = user_fact(source["content"])
    if source["role"] != "user" or _INDIRECT.search(fact):
        raise DomainError("InvalidTemporalMetadata", "Metadata requires a complete direct user statement")
    expected, basis = {}, {}
    for clause in re.split(r"[。；;\n]", fact):
        clause = clause.strip()
        match = _RANGE.fullmatch(clause) or _START.fullmatch(clause) or _END.fullmatch(clause)
        if match:
            for token_key, field in (("start", "valid_from"), ("end", "valid_until")):
                token = match.groupdict().get(token_key)
                if token is not None:
                    if field in expected:
                        raise DomainError("InvalidTemporalMetadata", "Multiple validity clauses cannot establish one interval")
                    try:
                        instant, precision = boundary(token, source, field == "valid_until")
                    except (ValueError, OverflowError) as exc:
                        raise DomainError("InvalidTemporalMetadata", "Invalid source validity date") from exc
                    expected[field] = instant
                    basis[field] = {"message_id": source["message_id"], "quote": clause, "precision": precision}
        scope = _SCOPE.fullmatch(clause)
        if scope:
            if "scope" in expected:
                raise DomainError("InvalidTemporalMetadata", "Multiple scopes cannot establish one applicability range")
            expected["scope"] = scope["scope"].strip()
            if not expected["scope"]:
                raise DomainError("InvalidTemporalMetadata", "Scope cannot be empty")
            basis["scope"] = {"message_id": source["message_id"], "quote": clause}
    if "valid_from" in expected and "valid_until" in expected and expected["valid_from"] >= expected["valid_until"]:
        raise DomainError("InvalidTemporalMetadata", "Source validity interval is empty or reversed")
    return expected, basis


def allowed_metadata(source):
    """Pre-request guidance, never a repair of the model's response or permission."""
    try:
        expected, _ = explicit_fields(source)
    except DomainError:
        return {}  # Unprovable metadata is optional; preserve the original prose.
    return {key: value.isoformat() if isinstance(value, datetime) else value for key, value in expected.items()}


def validate(candidate, sources):
    """Return canonical fields and small evidence; never remove invalid fields."""
    provided = {key: candidate[key] for key in FIELDS if candidate.get(key) is not None}
    evidence = {"version": VERSION, "status": "not_provided", "interval": "[from,until)",
                "sources": [{"message_id": s["message_id"], "created_at": s["created_at"],
                             "source_timezone": s.get("source_timezone")} for s in sources], "basis": {}}
    if not provided:
        return dict(candidate), evidence
    if len(sources) != 1 or sources[0]["role"] != "user" or candidate["evidence_kind"] != "user_statement":
        raise DomainError("InvalidTemporalMetadata", "Validity/scope requires one direct user source")
    source = sources[0]
    fact, _ = user_fact(source["content"])
    if normalized(candidate["content"]) != normalized(fact) or _INDIRECT.search(fact):
        raise DomainError("InvalidTemporalMetadata", "Validity/scope must support the complete direct fact, not a quote or inference")
    expected, evidence["basis"] = explicit_fields(source)
    result = dict(candidate)
    for field, value in provided.items():
        if field not in expected:
            raise DomainError("InvalidTemporalMetadata", f"{field} has no supported explicit validity/scope clause")
        if field == "scope":
            if value != expected[field]:
                raise DomainError("InvalidTemporalMetadata", "Scope differs from the direct source restriction")
        else:
            if aware(value).astimezone(timezone.utc) != expected[field]:
                raise DomainError("InvalidTemporalMetadata", f"{field} differs from the source boundary")
            result[field] = expected[field].isoformat()
    if result.get("valid_from") and result.get("valid_until") and aware(result["valid_from"]) >= aware(result["valid_until"]):
        raise DomainError("InvalidTemporalMetadata", "Validity interval is empty or reversed")
    evidence["status"] = "validated"
    # Only fields actually supplied and checked are claimed as validated.
    evidence["basis"] = {key: value for key, value in evidence["basis"].items() if key in provided}
    return result, evidence


def duplicate(candidate, sources, existing, existing_sources):
    """Stable duplicates remain global to an Agent; temporal facts need anchors."""
    if normalized(candidate["content"]) != normalized(existing["content"]):
        return False
    if any(candidate.get(k) != existing[k] for k in FIELDS):
        return False
    if any(candidate.get(k) is not None for k in FIELDS) or _TEMPORARY.search(candidate["content"]):
        current = {(s["message_id"], s["created_at"], s.get("source_timezone")) for s in sources}
        previous = {(s["message_id"], s["created_at"], s.get("source_timezone")) for s in existing_sources}
        return current == previous
    return True
