"""User-owned conversation organization. No context, permissions or model calls."""
import json
from uuid import uuid4

from .errors import DomainError
from .identity import now

COMMANDS = {'CreateConversationGroup', 'UpdateConversationGroup',
            'DeleteConversationGroup', 'OrganizeConversations', 'RenameConversation'}
MIGRATION = (
    """CREATE TABLE conversation_groups (
       group_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents,
       name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 60), position INTEGER NOT NULL,
       pinned INTEGER NOT NULL DEFAULT 0, collapsed INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL, UNIQUE(group_id,agent_id), UNIQUE(agent_id,name COLLATE NOCASE))""",
    """CREATE TABLE conversation_organization (
       conversation_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, group_id TEXT,
       pinned INTEGER NOT NULL DEFAULT 0,
       FOREIGN KEY(conversation_id,agent_id) REFERENCES conversations(conversation_id,agent_id),
       FOREIGN KEY(group_id,agent_id) REFERENCES conversation_groups(group_id,agent_id))""",
    "CREATE INDEX conversation_group_members ON conversation_organization(agent_id,group_id)",
    """CREATE TABLE conversation_layout (
       agent_id TEXT PRIMARY KEY REFERENCES agents, revision INTEGER NOT NULL DEFAULT 0)""",
)


class ConversationGroups:
    def __init__(self, store):
        self.store = store

    def target(self, db, aid, gid):
        row = db.execute('SELECT * FROM conversation_groups WHERE group_id=? AND agent_id=?', (gid, aid)).fetchone()
        if row is None:
            raise DomainError('NotFound', '分组不属于当前 Agent，或已被删除')
        return dict(row)

    def view(self, db, aid):
        row = db.execute('SELECT revision FROM conversation_layout WHERE agent_id=?', (aid,)).fetchone()
        return {'organization_revision': row[0] if row else 0,
                'conversation_groups': [dict(r) for r in db.execute(
                    'SELECT * FROM conversation_groups WHERE agent_id=? ORDER BY position,created_at,group_id', (aid,))]}

    def name(self, db, aid, value, gid=None):
        value = value.strip()
        if not 1 <= len(value) <= 60:
            raise DomainError('ValidationError', '分组名称须为 1–60 个字符')
        if db.execute('SELECT 1 FROM conversation_groups WHERE agent_id=? AND name=? COLLATE NOCASE AND group_id<>?', (aid, value, gid or '')).fetchone():
            raise DomainError('ValidationError', '当前 Agent 已有同名分组')
        return value

    def assign_new(self, db, aid, cid, gid):
        self.target(db, aid, gid)
        db.execute('INSERT INTO conversation_organization(conversation_id,agent_id,group_id) VALUES (?,?,?)', (cid, aid, gid))

    def command(self, db, command, serialized):
        aid, kind, p = command['agent_id'], command['type'], command['payload']
        self.store.identity.agent(db, aid)
        db.execute('INSERT OR IGNORE INTO conversation_layout(agent_id) VALUES (?)', (aid,))
        revision = db.execute('SELECT revision FROM conversation_layout WHERE agent_id=?', (aid,)).fetchone()[0]
        if command.get('expected_revision') != revision:
            raise DomainError('RevisionConflict', '分类已在其他窗口更新，请刷新后重试；输入草稿已保留')
        gid = p.get('group_id')
        if kind == 'CreateConversationGroup':
            name = self.name(db, aid, p['name'])
            gid = str(uuid4())
            position = db.execute('SELECT COALESCE(MAX(position),-1)+1 FROM conversation_groups WHERE agent_id=?', (aid,)).fetchone()[0]
            db.execute('INSERT INTO conversation_groups(group_id,agent_id,name,position,created_at) VALUES (?,?,?,?,?)', (gid, aid, name, position, now()))
        elif kind in ('UpdateConversationGroup', 'DeleteConversationGroup'):
            group = self.target(db, aid, gid)
            if kind == 'DeleteConversationGroup':
                db.execute('UPDATE conversation_organization SET group_id=NULL WHERE group_id=? AND agent_id=?', (gid, aid))
                db.execute('DELETE FROM conversation_groups WHERE group_id=? AND agent_id=?', (gid, aid))
            else:
                if 'name' in p:
                    db.execute('UPDATE conversation_groups SET name=? WHERE group_id=?', (self.name(db, aid, p['name'], gid), gid))
                for field in ('pinned', 'collapsed'):
                    if field in p:
                        db.execute(f'UPDATE conversation_groups SET {field}=? WHERE group_id=?', (int(p[field]), gid))
                if 'direction' in p:
                    groups = self.view(db, aid)['conversation_groups']
                    index = next(i for i, item in enumerate(groups) if item['group_id'] == gid)
                    other_index = index + (-1 if p['direction'] == 'up' else 1)
                    if 0 <= other_index < len(groups):
                        other = groups[other_index]
                        db.execute('UPDATE conversation_groups SET position=? WHERE group_id=?', (other['position'], gid))
                        db.execute('UPDATE conversation_groups SET position=? WHERE group_id=?', (group['position'], other['group_id']))
        elif kind == 'RenameConversation':
            cid = p['conversation_id']
            self.store.conversation.target(db, aid, cid)
            title = p['title'].strip()
            if not 1 <= len(title) <= 120:
                raise DomainError('ValidationError', '对话名称须为 1–120 个字符')
            db.execute('INSERT OR IGNORE INTO conversation_organization(conversation_id,agent_id) VALUES (?,?)', (cid, aid))
            db.execute('UPDATE conversation_organization SET custom_title=? WHERE conversation_id=? AND agent_id=?', (title, cid, aid))
        elif kind == 'OrganizeConversations':
            if not ('group_id' in p or 'pinned' in p):
                raise DomainError('ValidationError', '请选择分组或置顶操作')
            ids = list(dict.fromkeys(p['conversation_ids']))
            if not 1 <= len(ids) <= 500:
                raise DomainError('ValidationError', '每次可整理 1–500 个对话')
            if gid is not None:
                self.target(db, aid, gid)
            # Validate every member before changing any membership.
            for cid in ids:
                self.store.conversation.target(db, aid, cid)
            for cid in ids:
                db.execute('INSERT OR IGNORE INTO conversation_organization(conversation_id,agent_id) VALUES (?,?)', (cid, aid))
                for field in ('group_id', 'pinned'):
                    if field in p:
                        value = int(p[field]) if field == 'pinned' else p[field]
                        db.execute(f'UPDATE conversation_organization SET {field}=? WHERE conversation_id=? AND agent_id=?', (value, cid, aid))
        revision += 1
        db.execute('UPDATE conversation_layout SET revision=? WHERE agent_id=?', (revision, aid))
        self.store.event(db, command['command_id'], kind, aid, p)
        data = self.view(db, aid) | {'group_id': gid}
        response = {'command_id': command['command_id'], 'status': 'persisted', 'data': data}
        db.execute('INSERT INTO command_results VALUES (?,?,?)', (command['command_id'], serialized, json.dumps(response)))
        return response
