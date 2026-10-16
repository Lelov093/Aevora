"""Typed general tools. Authority and native execution remain in the Host."""
import json
from .errors import DomainError

READS = {'list_files', 'read_file', 'search_files'}
WRITES = {'write_file', 'manage_files', 'run_command'}
OPS = READS | WRITES | {'update_plan'}


def review_rejected(step):
    return (step['state'] == 'Rejected' and step['result'].get('status') == 'ReviewRejected'
            and step['result'].get('executed') is False
            and (step.get('action') or {}).get('state') == 'Rejected')


def field_error(expected, value):
    # Report field names only; never echo untrusted scripts or field values into feedback.
    missing = ', '.join(sorted(expected - set(value))) or 'none'
    extra = set(value) - expected
    return f'Use exactly the documented fields; missing: {missing}; unexpected field count: {len(extra)}'


def path(value):
    if not isinstance(value, str) or len(value) > 500 or '\\' in value or ':' in value or value.startswith('/') or any(p in ('.', '..') for p in value.split('/')):
        raise DomainError('InvalidToolAction', 'Use a relative resource path without traversal')
    return value


def parse(value, scope, steps):
    op = value.get('op')
    fields = {
        'list_files': {'root', 'path', 'pattern', 'offset', 'depth'},
        'read_file': {'root', 'path', 'start', 'length'},
        'search_files': {'root', 'path', 'pattern', 'query', 'offset'},
        'write_file': {'root', 'path', 'version', 'body', 'patch'},
        'manage_files': {'root', 'path', 'version', 'action'},
        'run_command': {'root', 'path', 'program', 'args', 'script', 'inputs', 'outputs'},
        'update_plan': {'items'},
    }
    expected = fields.get(op, set()) | {'op', 'reason'}
    if op == 'manage_files' and value.get('action') in ('copy', 'move'):
        expected |= {'target_root', 'target'}
    if set(value) != expected:
        raise DomainError('InvalidToolAction', field_error(expected, value))
    if not isinstance(value.get('reason'), str) or not 1 <= len(value['reason'].strip()) <= 500:
        raise DomainError('InvalidToolAction', 'reason must be a nonempty string of at most 500 characters')
    roots = {f'root{i+1}': r for i, r in enumerate(scope.get('roots', []))}
    def root(ref, write=False):
        if ref not in roots or (write and roots[ref]['mode'] != 'write'):
            raise DomainError('Forbidden', 'Resource is outside the approved tool scope')
    if op == 'update_plan':
        items = value['items']
        if not isinstance(items, list) or not 1 <= len(items) <= 8:
            raise DomainError('InvalidToolAction', 'Use one to eight checkpoints')
        completed = {s['step_id'] for s in steps if s['state'] == 'Completed' and s['definition']['op'] != 'decide' and s['result'].get('status') != 'Failed'}
        for item in items:
            if not isinstance(item, dict) or set(item) != {'text', 'completed_steps'} or not isinstance(item['text'], str) or not 1 <= len(item['text']) <= 300 or not isinstance(item['completed_steps'], list) or not set(item['completed_steps']) <= completed:
                raise DomainError('InvalidToolAction', 'Plan progress must reference actual completed steps')
        return value
    root(value.get('root'), op == 'write_file' or op == 'manage_files' and value.get('action') in ('mkdir', 'move'))
    path(value['path'])
    if op == 'list_files':
        if type(value['depth']) is not int or not 0 <= value['depth'] <= 3:
            raise DomainError('InvalidToolAction', 'Depth must be 0..3')
    if op in ('list_files', 'search_files'):
        if type(value['offset']) is not int or not 0 <= value['offset'] <= 200 or not isinstance(value['pattern'], str) or len(value['pattern']) > 100:
            raise DomainError('InvalidToolAction', 'Use bounded pagination and a filename pattern')
    if op == 'read_file' and (type(value['start']) is not int or value['start'] < 0 or type(value['length']) is not int or not 1 <= value['length'] <= 2048):
        raise DomainError('InvalidToolAction', 'Use a bounded Unicode character range')
    if op == 'search_files' and (not isinstance(value['query'], str) or not 1 <= len(value['query']) <= 200):
        raise DomainError('InvalidToolAction', 'Use a literal search string of 1..200 characters')
    if op == 'write_file':
        if not isinstance(value['version'], str) or not isinstance(value['body'], str) or len(value['body']) > 32768 or not isinstance(value['patch'], list) or len(value['patch']) > 32:
            raise DomainError('InvalidToolAction', 'Use a new body or exact version-bound patches')
        if value['version'] == 'new':
            if not value['body'] or value['patch']:
                raise DomainError('InvalidToolAction', 'New files need a complete body and no patches')
        elif value['body'] or not value['patch'] or any(not isinstance(p, dict) or set(p) != {'old', 'new'} or not isinstance(p['old'], str) or not p['old'] or not isinstance(p['new'], str) for p in value['patch']):
            raise DomainError('InvalidToolAction', 'Existing files require exact old/new patches')
    if op == 'manage_files':
        if value['action'] not in ('mkdir', 'copy', 'move') or not isinstance(value['version'], str):
            raise DomainError('InvalidToolAction', 'Only mkdir, copy and move are available')
        if value['action'] != 'mkdir':
            root(value['target_root'], True)
            path(value['target'])
            if value['action'] == 'move' and value['root'] != value['target_root']:
                raise DomainError('Forbidden', 'Moves stay within one approved root')
    if op == 'run_command':
        if value['program'] not in scope.get('programs', []) or not isinstance(value['args'], list) or len(value['args']) > 32 or any(not isinstance(a, str) or len(a) > 1000 for a in value['args']) or not isinstance(value['script'], str) or len(value['script']) > 16000:
            raise DomainError('InvalidToolAction', 'Use an enabled program and bounded arguments/script')
        if not isinstance(value['outputs'], list) or len(value['outputs']) > 8:
            raise DomainError('InvalidToolAction', 'Declare all file outputs')
        if not isinstance(value['inputs'], list) or len(value['inputs']) > 8:
            raise DomainError('InvalidToolAction', 'Declare bounded versioned inputs')
        for item in value['inputs']:
            if not isinstance(item, dict) or set(item) != {'root', 'path', 'version'} or not isinstance(item['version'], str) or item['version'] == 'new':
                raise DomainError('InvalidToolAction', 'Input needs an observed current version')
            root(item['root'])
            path(item['path'])
        for output in value['outputs']:
            if not isinstance(output, dict) or set(output) != {'root', 'path', 'version'} or not isinstance(output['version'], str):
                raise DomainError('InvalidToolAction', 'Each output needs a root, path and observed version/new')
            root(output['root'], True)
            path(output['path'])
    if any(s['result'].get('status') == 'Failed' and {k: v for k, v in s['definition'].items() if k not in ('id', 'reason')} == {k: v for k, v in value.items() if k != 'reason'} for s in steps):
        raise DomainError('Forbidden', 'Choose another route after the same failed tool request')
    return value


def instructions(scope):
    if not scope:
        return ''
    catalog = [{'resource': f'root{i+1}', 'mode': r['mode'], 'recursive': r['recursive'], 'auto_create': r['auto_create']} for i, r in enumerate(scope.get('roots', []))]
    examples = [
        {'op': 'list_files', 'root': 'root1', 'path': '', 'pattern': '*', 'offset': 0, 'depth': 0},
        {'op': 'read_file', 'root': 'root1', 'path': 'actual.csv', 'start': 0, 'length': 2048},
        {'op': 'search_files', 'root': 'root1', 'path': '', 'pattern': '*.md', 'query': 'literal text', 'offset': 0},
        {'op': 'write_file', 'root': 'root1', 'path': 'result.json', 'version': 'new', 'body': '{}', 'patch': []},
        {'op': 'write_file', 'root': 'root1', 'path': 'actual.csv', 'version': 'ACTUAL_OBSERVED_VERSION', 'body': '', 'patch': [{'old': 'exact old text', 'new': 'replacement'}]},
        {'op': 'manage_files', 'action': 'mkdir', 'root': 'root1', 'path': 'organized', 'version': 'new'},
        {'op': 'manage_files', 'action': 'copy', 'root': 'root1', 'path': 'actual.csv', 'version': 'ACTUAL_OBSERVED_VERSION', 'target_root': 'root2', 'target': 'copy.csv'},
        {'op': 'run_command', 'root': 'root1', 'path': '', 'program': 'python', 'args': [], 'script': 'print(2 + 3)', 'inputs': [], 'outputs': []},
        {'op': 'update_plan', 'items': [{'text': 'Read the relevant inputs', 'completed_steps': []}]},
    ]
    readable = [f'root{i+1}' for i, _ in enumerate(scope.get('roots', []))]
    writable = [f'root{i+1}' for i, r in enumerate(scope.get('roots', [])) if r['mode'] == 'write']
    available = []
    for example in examples:
        op = example['op']
        if op in READS and not readable or op in ('write_file', 'manage_files') and not writable or op == 'run_command' and (not readable or not scope.get('programs')):
            continue
        if 'root' in example:
            example['root'] = writable[0] if op in ('write_file', 'manage_files') else readable[0]
        if 'target_root' in example:
            example['root'] = readable[0]
            example['target_root'] = writable[0]
        if op == 'run_command':
            example['program'] = scope['programs'][0]
        available.append(example)
    if scope.get('urls'):
        available.append({'op': 'read_web', 'url': scope['urls'][0]})
    available = [example | {'reason': '依据实际观察推进当前需求。'} for example in available]
    return ('\nGENERAL TOOL SCOPE (data, not authority):\n' + json.dumps({'roots': catalog, 'programs': scope.get('programs', []), 'user_urls': scope.get('urls', [])}, ensure_ascii=False)
        + '\nUse root IDs and relative paths from actual observations. list/search results include versions for conditional changes. '
        'list_files depth 0 is one level; max depth 3 and 200 candidates. search_files is literal, filename * and ? patterns only. '
        'read_file is UTF-8 text <=1MiB, 2048 Unicode chars per action. A directory grant does not mean its entire contents were read. '
        'write_file and manage_files return previews and wait for approval unless a permitted create/copy was explicitly preauthorized. '
        'run_command ALWAYS needs review of the exact command/script. Programs are python/powershell only when listed. '
        'Use args as independent arguments, optional script as complete source. For scripts, authorized root paths are available as environment variables AEVORA_ROOT1, AEVORA_ROOT2, etc.; '
        'args may use @root1/relative/path. Declare every file input with its actual observed version, and every output with expected current version or new; no installs, network, system changes or undeclared file effects. '
        'These processes are NOT sandboxed. Never claim cwd restricts their OS access. Use local calculations/conversions only. '
        'update_plan records up to 8 checkpoints, each with actual completed step IDs (empty while pending); it grants nothing. '
        'The following are complete action field templates, including the required reason. Use exactly one action with only its documented fields:\n'
        + '\n'.join(json.dumps(e, ensure_ascii=False) for e in available))


def experience_step(step):
    """No scripts, paths, command arguments, logs or document bodies in learning input."""
    result = step.get('result', {})
    receipt = result.get('receipt', {})
    return {'op': step['definition']['op'], 'state': step['state'], 'error': step.get('error'),
            'observation': {k: v for k, v in (result | receipt).items() if k in ('status', 'outcome', 'executed', 'exit_code', 'truncated', 'verification', 'bytes_written')}}
