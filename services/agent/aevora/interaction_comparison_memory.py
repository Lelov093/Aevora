"""Explicit Memory versions for isolated dialogue comparisons; no recall calls."""
import json

from .errors import DomainError
from .identity import now
from .interaction_memory import used_memories
from .memory_governance import erase_cached
from .recall import active


def resolve(store, db, aid, context):
    store.conversation.target(db, aid, context['conversation_id'])
    rows = {r['revision_id']: r for r in active(db, aid)}
    result = []
    for ref in context.get('memory_references', []):
        row = rows.get(ref['revision_id'])
        if not row or row['memory_id'] != ref['memory_id']:
            raise DomainError('ContextStale', 'Selected understanding changed or is no longer valid; review it again')
        local = json.loads(row['interaction_context'])
        if local.get('conversation_id') and local['conversation_id'] != context['conversation_id']:
            raise DomainError('ContextStale', 'Temporary understanding only applies to its original conversation')
        result.append(ref['revision_id'])
    return used_memories(store, db, aid, context | {'memory_revision_ids': result})


def prepare(store, db, aid, source_cid, selections):
    selections = selections or [{'conversation_id': source_cid, 'memories': []} for _ in range(3)]
    contexts = []
    for selection in selections:
        refs = selection['memories']
        if len({r['memory_id'] for r in refs}) != len(refs):
            raise DomainError('ValidationError', 'Select each memory only once per situation')
        context = {'conversation_id': selection['conversation_id'],
                   'memory_revision_ids': [r['revision_id'] for r in refs], 'memory_references': refs}
        memories = resolve(store, db, aid, context)
        context['memory_references'] = [{k: m[k] for k in ('memory_id', 'revision_id', 'type', 'evidence_kind', 'interaction_context')}
                                        for m in memories]
        contexts.append(context)
    return contexts


def current(store, db, aid, context):
    try:
        for case in context.get('memory_contexts', []):
            resolve(store, db, aid, case)
    except DomainError:
        return False
    return True


def invalidate(store, db, aid, revisions, erase):
    """Corrections keep original output; forgetting removes derived private text."""
    for row in db.execute('SELECT * FROM interaction_comparisons WHERE agent_id=?', (aid,)).fetchall():
        context = json.loads(row['context'])
        if not any(set(c.get('memory_revision_ids', [])) & set(revisions) for c in context.get('memory_contexts', [])):
            continue
        results = json.loads(row['results'])
        context['context_stale'] = True
        if erase:
            context['context_erased'] = True
            results = [{k: v for k, v in r.items() if k not in ('text', 'raw')} for r in results]
        db.execute("UPDATE interaction_comparisons SET state='Invalidated',context=?,results=?,updated_at=? WHERE comparison_id=?",
                   (json.dumps(context), json.dumps(results), now(), row['comparison_id']))
        proposal = store.evolution.target(db, aid, row['proposal_id'])
        if proposal['state'] == 'Eligible' and json.loads(proposal['evaluation'] or '{}').get('comparison_id') == row['comparison_id']:
            db.execute("UPDATE method_proposals SET state='Evaluating',evaluation=NULL,revision=revision+1,updated_at=? WHERE proposal_id=?",
                       (now(), proposal['proposal_id']))
        if erase:
            erase_cached(db, {row['comparison_id']})
