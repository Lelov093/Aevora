"""Typed document actions. Resource authority and execution remain in the native Host."""
import json
import re
import math
from datetime import datetime

from .errors import DomainError

OPS = {'office_inspect', 'office_read', 'office_calculate', 'office_propose', 'text_propose'}
WRITES = {'office_propose', 'text_propose'}


def fail(message):
    raise DomainError('InvalidDocumentAction', message)


def catalog(documents):
    return [{'resource': f'document{i+1}', **{k: d[k] for k in ('label', 'format', 'mode', 'scope')}}
            for i, d in enumerate(documents)]


def resource(documents, ref):
    match = re.fullmatch(r'document([1-4])', ref) if isinstance(ref, str) else None
    if not match or int(match[1]) > len(documents):
        fail('Use only a selected document resource')
    return documents[int(match[1])-1]


def formula(value):
    if not isinstance(value, str) or len(value) > 300 or not value.startswith('='):
        fail('Use a bounded scalar formula beginning with =')
    # Same-sheet A1 references, arithmetic and six scalar aggregates. Native Host
    # independently checks every referenced cell against the selected scope.
    rest = re.sub(r'\b(?:SUM|AVERAGE|COUNT|MIN|MAX)\b|\$?[A-Z]{1,3}\$?[1-9][0-9]{0,6}(?::\$?[A-Z]{1,3}\$?[1-9][0-9]{0,6})?', '', value[1:])
    if not re.fullmatch(r'[0-9\s.+*/(),\-]*', rest, re.ASCII):
        fail('Only same-sheet cells, arithmetic and supported scalar aggregates are allowed')
    return value


def patch(value, document):
    if not isinstance(value, list) or not 1 <= len(value) <= 20:
        fail('Propose 1..20 exact changes')
    used = set()
    for change in value:
        if not isinstance(change, dict):
            fail('Each change must be a typed object')
        fmt = document['format']
        if fmt == 'docx':
            if document['mode'] == 'create':
                keys = {'type', 'text'}
                if change.get('type') == 'table':
                    keys = {'type', 'rows'}
                    rows = change.get('rows')
                    if not isinstance(rows, list) or not 1 <= len(rows) <= 20 or any(
                            not isinstance(r, list) or not 1 <= len(r) <= 10 or
                            any(not isinstance(c, str) or len(c) > 1000 or '\r' in c or '\n' in c for c in r) for r in rows) or len({len(r) for r in rows}) != 1:
                        fail('Use a rectangular ordinary Word table')
                elif change.get('type') not in ('paragraph', 'heading'):
                    fail('Create ordinary paragraphs, headings or tables')
            else:
                keys = {'target', 'old', 'text'}
                if not isinstance(change.get('old'), str):
                    fail('Word old content must be the observed text')
                if not re.fullmatch(r'p[1-9][0-9]*|t[1-9][0-9]*r[1-9][0-9]*c[1-9][0-9]*', str(change.get('target', ''))):
                    fail('Use an observed paragraph or ordinary table-cell ID')
            if 'text' in keys and (not isinstance(change.get('text'), str) or len(change['text']) > 6000 or '\r' in change['text'] or '\n' in change['text'] or '\x07' in change['text']):
                fail('A Word text change cannot insert paragraph/table boundaries')
        elif fmt == 'xlsx':
            keys = {'sheet', 'cell', 'old', 'value', 'kind'}
            if not isinstance(change.get('sheet'), str) or not re.fullmatch(r'[A-Z]{1,3}[1-9][0-9]{0,6}', str(change.get('cell', ''))):
                fail('Use an exact worksheet and scalar cell address')
            kind, item = change.get('kind'), change.get('value')
            if kind not in ('empty', 'text', 'number', 'boolean', 'date', 'formula'):
                fail('Choose an explicit cell type')
            if kind == 'formula': formula(item)
            elif kind == 'number' and (type(item) not in (float, int) or not math.isfinite(item)): fail('Use a finite number')
            elif kind == 'boolean' and type(item) is not bool: fail('Use a boolean')
            elif kind == 'empty' and item is not None: fail('Empty cells have a null value')
            elif kind in ('text', 'date') and (not isinstance(item, str) or len(item) > 6000): fail('Use bounded text or an ISO date')
            if kind == 'date':
                try: date = datetime.fromisoformat(item)
                except ValueError: fail('Use an unambiguous ISO date')
                if date.tzinfo is not None: fail('Excel dates have no timezone; choose an explicit local calendar time')
                change['value'] = date.isoformat(timespec='seconds')
            if 'number_format' in change:
                keys.add('number_format')
                if not isinstance(change['number_format'], str) or len(change['number_format']) > 100:
                    fail('Use a bounded explicit number format')
        else:
            keys = {'old', 'text'}
            if not isinstance(change.get('old'), str) or not change['old'] or not isinstance(change.get('text'), str):
                fail('Text changes require an exact nonempty old range and replacement')
        if set(change) != keys:
            fail('Use exactly the fields for this change type')
        if document['mode'] != 'create' and not isinstance(change.get('old'), (str, dict)):
            fail('Bind the change to its actual observed old content')
        key = (change.get('sheet'), change.get('cell', change.get('target', change.get('old'))))
        key = json.dumps(key, sort_keys=True)
        if (document['mode'] != 'create' or fmt == 'xlsx') and key in used:
            fail('Do not overlap or repeat a target')
        used.add(key)
    if len(json.dumps(value, ensure_ascii=False)) > 24000:
        fail('Change list exceeds capacity')
    return value


def parse(value, documents, steps):
    op = value['op']
    fields = {'office_inspect': {'resource'}, 'office_read': {'resource', 'target', 'start', 'length'},
              'office_calculate': {'resource', 'sheet', 'formula'},
              'office_propose': {'resource', 'version', 'changes'},
              'text_propose': {'resource', 'version', 'changes'}}
    if set(value) != {'op', 'reason', *fields[op]}:
        fail('Use exact document action fields')
    document = resource(documents, value['resource'])
    reads = [s for s in steps if s['definition'].get('resource') == value['resource'] and
             s['definition'].get('op') in ('office_read', 'office_inspect') and s['result'].get('status') == 'Success']
    if op == 'office_read':
        if document['mode'] == 'create' and not any(s['definition'].get('resource') == value['resource'] and s['result'].get('receipt', {}).get('outcome') == 'Success' for s in steps):
            fail('New documents cannot be read before a confirmed save')
        if not isinstance(value['target'], str) or len(value['target']) > 200 or type(value['start']) is not int or value['start'] < 0 or type(value['length']) is not int or not 1 <= value['length'] <= (200 if document['format'] == 'xlsx' else 2048 if document['format'] in ('md', 'txt') else 20):
            fail('Use a bounded exact document range')
    elif op == 'office_calculate':
        if document['format'] != 'xlsx' or not reads or not isinstance(value['sheet'], str):
            fail('Read the selected workbook before calculating')
        formula(value['formula'])
    elif op in WRITES:
        if document['mode'] == 'read' or (op == 'text_propose') != (document['format'] in ('md', 'txt')):
            fail('This action has no selected write scope')
        if any(s['definition'].get('resource') == value['resource'] and s['definition']['op'] in WRITES for s in steps):
            fail('Only one proposal per selected document; review or create newly authorized work')
        if document['mode'] != 'create' and not any(s['definition']['op'] == 'office_read' for s in reads):
            fail('Read the actual target before proposing an update')
        if document['mode'] == 'create':
            if value['version'] != 'new':
                fail('A selected create-only target requires version new')
        elif not isinstance(value['version'], str) or not any(s['result'].get('version') == value['version'] for s in reads):
            fail('Bind the proposal to an actual Host resource version')
        patch(value['changes'], document)
    for s in steps:
        if s['result'].get('status') == 'Failed' and all(s['definition'].get(k) == v for k, v in value.items() if k != 'reason'):
            fail('Do not repeat the same failed document action')
    return value


def instructions():
    return ('\nDOCUMENT ACTIONS: Use only selected document IDs, never file paths or application commands. '
        'For every document1...document4, use office_read, NOT the ordinary read action. '
        'Ordinary read is only for source1... or confirmed legacy output1... resources. '
        'office_inspect: resource; returns actual bounded structure and version (new target version is new). '
        'For a selected create-mode target, propose directly with version "new"; target inspection is optional. '
        'For an existing update-mode target, read its actual content first and copy its observed version. '
        'Host still validates the selected create-only destination and refuses an existing final file; new is not permission. '
        'office_read: resource,target,start,length; Word target body or an observed paragraph/table-cell ID; '
        'start is the zero-based offset within the selected permitted targets, length <=20; '
        'Excel target Sheet!A1:B10, start=0,length <=200 cells; text target body, start is Unicode offset,length <=2048. '
        'office_calculate: resource,sheet,formula; same-sheet scalar arithmetic/SUM/AVERAGE/COUNT/MIN/MAX, only authorized cells. '
        'office_propose or text_propose: resource,version,changes; one proposal waits for human diff review. '
        'Word update: each change has target,old,text; copy the observed target ID and complete old text. '
        'New Word: each change has type and text (heading/paragraph), or type and rows (ordinary table). '
        'Excel: each change has sheet,cell,old,kind,value, with optional number_format. '
        'kind and value are TOP-LEVEL fields of each change, NOT inside a new object. There is no new field. '
        'For existing Excel cells, old must copy the COMPLETE observed cell object unchanged, including '
        'sheet,cell,kind,value,formula,number_format,date_system and any other returned fields. '
        'A formula old value includes both the formula and its observed cached value. For new workbook cells, old is null. '
        'New kind is text/number/boolean/date/formula/empty; value is typed accordingly; formula begins with =. '
        'Preserve the old number format unless the request requires changing it. '
        'Text update: each change has old (exact unique observed nonempty text) and text (replacement). Changes <=20. '
        'Read targets before updates, preserve unselected content and types, never claim a save before its successful native receipt. '
        'Formula results are actual tool observations, not mental arithmetic. Whole-document claims require actual coverage. '
        'Workbook reads explicitly label stored formula values that were not recalculated; use office_calculate when a new calculation is needed. '
        'All actions also require op and reason. Use the complete independent JSON examples below; '
        'their sample content, versions and numbers are field illustrations, NOT observations or permission.')


def examples(documents):
    """Complete field templates for selected formats/modes, without private paths.

    Illustrative old values and versions must be replaced with actual receipts;
    these examples never authorize a resource or a write.
    """
    values, seen = [], set()
    for index, document in enumerate(documents, 1):
        fmt, mode = document['format'], document['mode']
        if (fmt, mode) in seen:
            continue
        seen.add((fmt, mode))
        ref = f'document{index}'
        values.append({'op': 'office_inspect', 'reason': '检查选定资源的结构与版本。', 'resource': ref})
        sheet, cell = 'Data', 'A1'
        target = 'body'
        if fmt == 'xlsx':
            target = document['scope'] if document['scope'] != '*' else 'Data!A1:B3'
            sheet, area = target.rsplit('!', 1)
            cell = area.split(':', 1)[0]
        if mode != 'create':
            values.append({'op': 'office_read', 'reason': '读取允许范围内的实际内容。',
                           'resource': ref, 'target': target, 'start': 0,
                           'length': 6 if fmt == 'xlsx' else 20 if fmt == 'docx' else 2048})
            if fmt == 'xlsx':
                values.append({'op': 'office_calculate', 'reason': '依据实际读取的选定单元格计算。',
                               'resource': ref, 'sheet': sheet, 'formula': f'=SUM({cell}:{cell})'})
        if mode == 'read':
            continue
        if fmt == 'docx':
            if mode == 'create':
                changes = [{'type': 'heading', 'text': '依据实际数据拟定的标题'},
                           {'type': 'paragraph', 'text': '依据实际观察拟定的正文'},
                           {'type': 'table', 'rows': [['项目', '说明'], ['实际项目', '实际说明']]}]
            else:
                selected = document['scope'].split(',')[0] if document['scope'] != '*' else 'p1'
                changes = [{'target': selected, 'old': '实际读取的完整原文', 'text': '用户要求的新文本'}]
        elif fmt == 'xlsx':
            old = None if mode == 'create' else {
                'sheet': sheet, 'cell': cell, 'kind': 'number', 'value': 8,
                'formula': None, 'number_format': 'General', 'date_system': '1900'}
            changes = [{'sheet': sheet, 'cell': cell, 'old': old, 'kind': 'number', 'value': 12.5}]
        else:
            changes = [{'old': '实际读取的唯一原文', 'text': '用户要求的新文本'}]
        values.append({'op': 'text_propose' if fmt in ('md', 'txt') else 'office_propose',
                       'reason': '依据实际读取提出修改，等待用户审阅批准保存。', 'resource': ref,
                       'version': 'new' if mode == 'create' else '实际读取返回的版本', 'changes': changes})
        if fmt == 'xlsx':
            values.append({'op': 'office_propose', 'reason': '依据用户需求提出受限公式，等待批准保存。',
                           'resource': ref, 'version': 'new' if mode == 'create' else '实际读取返回的版本',
                           'changes': [{'sheet': sheet, 'cell': cell, 'old': old,
                                        'kind': 'formula', 'value': '=SUM(1,2)'}]})
    return values
