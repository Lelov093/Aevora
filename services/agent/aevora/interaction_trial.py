"""Explicit candidate use for one foreground reply, without adoption or evaluation PASS."""
import json

from .errors import DomainError
from .evolution import binding
from .interaction_evaluation import active_refs


def approve(store, db, aid, grant, config):
    if grant.get('allow_outbound') is not True or grant.get('provider') != binding(config):
        raise DomainError('Forbidden', 'Confirm this candidate trial for the current Provider')
    ref = {k: grant[k] for k in ('proposal_id', 'revision')} | {'mode': 'evaluation'}
    method = store.evolution.resolve(db, aid, ref)
    row = store.evolution.target(db, aid, ref['proposal_id'])
    if method['family'] != 'communication' or json.loads(row['provider']) != binding(config):
        raise DomainError('ContextStale', 'Select a current communication candidate for this Provider')
    return grant | {'title': method['title'], 'method': method}


def references(store, db, aid, trial, config):
    approve(store, db, aid, trial, config)
    row = store.evolution.target(db, aid, trial['proposal_id'])
    # A revision replaces its reviewed baseline only for this reply; other strategies remain.
    return [r for r in active_refs(store, db, aid, config) if r['proposal_id'] != row['base_active_id']] + [
        {k: trial[k] for k in ('proposal_id', 'revision')} | {'mode': 'evaluation'}]
