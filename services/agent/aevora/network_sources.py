"""Complete static source text with document sections, without semantic selection."""
from datetime import datetime, timezone
from html.parser import HTMLParser

from .errors import DomainError

STRUCTURE_VERSION = 'source-sections-v1'


class PageText(HTMLParser):
    hidden = {'script', 'style', 'noscript', 'template', 'svg', 'nav', 'footer'}
    boundaries = {'p', 'div', 'article', 'section', 'li', 'br', 'tr', 'pre', 'blockquote',
                  'ul', 'ol', 'table', 'dl', 'dt', 'dd'}
    headings = {'h1', 'h2', 'h3', 'h4', 'h5', 'h6'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hidden_stack = []
        self.title_parts = []
        self.in_title = False
        self.heading_level = None
        self.heading_parts = []
        self.path = []
        self.pending = []
        self.preformatted = False
        self.sections = [{'headings': [], 'paragraphs': []}]
        self.visible = []

    def flush(self):
        raw = ''.join(self.pending)
        text = raw.strip() if self.preformatted else ' '.join(raw.split())
        self.pending.clear()
        if text:
            self.sections[-1]['paragraphs'].append(text)
            self.visible.append(text)

    def handle_starttag(self, tag, attrs):
        if tag in self.hidden:
            self.hidden_stack.append(tag)
            return
        if self.hidden_stack:
            return
        if tag == 'title':
            self.in_title = True
        elif tag in self.headings:
            self.flush()
            self.heading_level = int(tag[1])
            self.heading_parts = []
        elif tag in self.boundaries:
            self.flush()
            if tag == 'pre':
                self.preformatted = True

    def handle_endtag(self, tag):
        if self.hidden_stack:
            if tag in self.hidden_stack:
                self.hidden_stack = self.hidden_stack[:self.hidden_stack.index(tag)]
            return
        if tag == 'title':
            self.in_title = False
        elif tag in self.headings and self.heading_level is not None:
            text = ' '.join(''.join(self.heading_parts).split())
            if text:
                self.path = [(level, title) for level, title in self.path if level < self.heading_level]
                self.path.append((self.heading_level, text))
                self.sections.append({'headings': [title for _, title in self.path], 'paragraphs': []})
                self.visible.append(text)
            self.heading_level = None
            self.heading_parts = []
        elif tag in self.boundaries:
            self.flush()
            if tag == 'pre':
                self.preformatted = False

    def handle_data(self, value):
        if self.hidden_stack:
            return
        if self.in_title:
            self.title_parts.append(value)
        elif self.heading_level is not None:
            self.heading_parts.append(value)
        else:
            self.pending.append(value)

    def finish(self):
        self.close()
        self.flush()
        # An unclosed heading is still source text, not discarded evidence.
        if self.heading_level is not None:
            text = ' '.join(''.join(self.heading_parts).split())
            if text:
                self.sections[-1]['paragraphs'].append(text)
                self.visible.append(text)
        return '\n\n'.join(self.visible), ' '.join(''.join(self.title_parts).split()), [
            section for section in self.sections if section['headings'] or section['paragraphs']]


def extract_page(result, limit=24000):
    body = result['body']
    if result['content_type'] == 'text/html':
        parser = PageText()
        parser.feed(body)
        text, title, sections = parser.finish()
    elif result['content_type'] in ('text/plain', 'text/markdown'):
        text, title = body, ''
        # Preserve the entire original text; no guessed headings or sentence selection.
        sections = [{'headings': [], 'paragraphs': [body]}]
    else:
        raise DomainError('UnsupportedSource', 'Only static HTML and UTF-8 text are supported')
    if not text.strip() or len(text) > limit:
        raise DomainError('SourceCapacity', 'Source text is empty or exceeds the configured capacity; it was not truncated')
    timestamp = result.get('fetched_at')
    if isinstance(timestamp, (int, float)):
        timestamp = datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
    return {k: v for k, v in result.items() if k != 'body'} | {
        'content': text, 'title': title, 'sections': sections, 'structure_version': STRUCTURE_VERSION,
        'status': 'Success', 'fetched_at': timestamp}
