"""Queries and per-output requirements reviewed together, without tool authority."""
import json

from .errors import DomainError

VERSION = 'network-plan-v3'
DELIVERY_CONTRACT = 'network-deliverables-v1'


def queries(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 3 or any(
        not isinstance(q, str) or not q.strip() or len(q) > 400 for q in value
    ) or len(set(value)) != len(value):
        raise DomainError('InvalidNetworkPlan', 'Select one to three distinct queries of at most 400 characters')
    return value


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError('duplicate property')
        result[key] = value
    return result


def parse_queries(raw):
    """Legacy query-only contract, retained for existing plans and developer tools."""
    try:
        value = json.loads(raw, object_pairs_hook=_pairs)
        if not isinstance(value, dict) or set(value) != {'queries'}:
            raise ValueError()
        return queries(value['queries'])
    except Exception:
        raise DomainError('InvalidNetworkPlan', 'Expected strict JSON with only a queries array') from None


def deliverables(value, output_count):
    if not isinstance(value, list) or len(value) != output_count or output_count not in (1, 2):
        raise DomainError('InvalidNetworkPlan', 'Provide requirements for exactly the selected outputs')
    for i, item in enumerate(value, 1):
        if not isinstance(item, dict) or set(item) != {'output', 'instruction'} or item['output'] != f'output{i}':
            raise DomainError('InvalidNetworkPlan', 'Requirements must match the selected outputs in order')
        instruction = item['instruction']
        if not isinstance(instruction, str) or not instruction.strip() or len(instruction) > 4000:
            raise DomainError('InvalidNetworkPlan', 'Each output needs complete requirements of at most 4000 characters')
    return value


def search_plan(values, requirements=None, output_count=None):
    plan = {'steps': [dict(id=f'search_{i+1}', op='search', query=q) for i, q in enumerate(queries(values))]
            + [dict(id='select_sources', op='select_sources')]}
    if requirements is not None:
        plan.update(delivery_contract=DELIVERY_CONTRACT, deliverables=deliverables(requirements, output_count))
    return plan


def parse_plan(raw, output_count):
    try:
        value = json.loads(raw, object_pairs_hook=_pairs)
        if not isinstance(value, dict) or set(value) != {'queries', 'deliverables'}:
            raise ValueError()
        instructions = value['deliverables']
        if not isinstance(instructions, list) or output_count not in (1, 2) or len(instructions) != output_count:
            raise ValueError()
        # Core assigns resource identities; the model supplies only ordered text.
        requirements = [{'output': f'output{i}', 'instruction': instruction}
                        for i, instruction in enumerate(instructions, 1)]
        return search_plan(value['queries'], deliverables(requirements, output_count), output_count)
    except (ValueError, TypeError):
        raise DomainError('InvalidNetworkPlan', 'Expected strict queries and per-output requirements JSON') from None


def planner_messages(goal, outputs):
    selected = [output['label'] for output in outputs]
    return [{'role': 'system', 'content':
        'Plan research, do not answer it. Propose 1 to 3 web search queries and faithfully restate '
        'the user requirements for EACH ordered output. You have not read any sources. '
        'You have no network, file or tool permission. No Persona or Memory is provided. '
        'Return exactly {"queries":["query"],"deliverables":["complete first output requirements",'
        '"complete second output requirements if selected"]}, no other properties. '
        'deliverables contains only strings, exactly one for each ordered output; no objects, '
        'identifiers, labels, paths, tools or permissions. Core owns output identities and bindings. '
        'Queries are distinct, at most 400 characters each; each instruction is at most 4000 characters. '
        'Write reviewable requirements in the language of the user goal; preserve the requested output language. '
        'Preserve the original research questions, scope, format and verification limits without adding '
        'answers or new topics. Keep questions as questions, retaining their wording when possible. '
        'Do not turn whether/how/under-which-conditions questions into factual assertions, choose an '
        'answer, assume alternatives behave the same, or remove unknown possibilities. '
        'The first report uses the actual public sources to be read later; no saved report or later '
        'user edits exist at that step. Put later deliverable requirements only in their '
        'own instruction. A follow-up uses the actually saved first report, including any user factual edits; '
        'a request to include future edits does not mean such edits already exist. Do not invent user notes '
        'or private facts. The user reviews and can edit queries AND output requirements before search.'},
        {'role': 'user', 'content': json.dumps({'goal': goal, 'ordered_outputs': selected}, ensure_ascii=False)}]
