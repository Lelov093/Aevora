"""Local request hints suggest a user control; text never executes a policy change."""
import re


def request_hint(text):
    if len(text) > 160 or any(c in text for c in ('"', '“', '”', '‘', '’', '`', '《', '》')):
        return None
    pause = bool(re.search(r'(?:别|不要|不用|停止|暂停).{0,16}(?:提醒|主动联系|主动通知)|'
                           r'(?:需要|有需要).{0,20}我.{0,12}(?:自己|自行|会).{0,8}(?:联系|找你)', text))
    resume = bool(re.search(r'恢复.{0,12}(?:提醒|主动联系|主动通知)', text))
    return None if pause == resume else 'silence' if pause else 'resume'
