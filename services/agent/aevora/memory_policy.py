"""Trusted, bounded low-risk domains; extractor confidence never grants authority.

Whole-source attribution and typed fact parsing establish risk independently of
model labels. Unknown domains and values stay reviewable, not implicitly safe.
"""
import re

POLICY_VERSION = "memory-policy-v4"
_REQUEST = re.compile(r"^(?:请)?记住(?:[：:，,]\s*|\s*(?=我|项目|这个项目))")
_CREDENTIAL = re.compile(r"密码|口令|API\s*KEY|access[_ -]?token|密钥|sk-[A-Za-z0-9]{12,}", re.I)
_SENSITIVE = re.compile(r"医院|就诊|诊断|治疗|病历|过敏|用药|药物|疾病|残疾|心理|抑郁|怀孕|性取向|性生活|宗教|信仰|政治|党派|身份证|护照|住址|家庭地址|手机号|电话号码|银行卡|银行账户|信用卡|薪资|工资|收入|债务|存款", re.I)
_UNCERTAIN = re.compile(r'["“”‘’`]|引用|转述|第三方|他说|她说|别人|虚构|假设|如果|也许|可能|据说|暂时|今天|明天|这两天|最近|本次|这次|仅|只在|不要记|别记|不保存|不是我的|不代表我')
_AUTHORITY = re.compile(r"自动批准|无需(?:询问|批准|确认)|跳过|绕过|权限|授权|执行|删除|上传|转账|购买|发送邮件|system|developer", re.I)
_FORMATS = {"markdown": ("Markdown", "md"), "text": ("纯文本", "文本", "TXT"), "pdf": ("PDF",), "docx": ("Word", "DOCX"), "html": ("HTML",)}
_COMMUNICATION = {"chinese": ("中文", "简体中文"), "english": ("英文", "英语"), "traditional": ("繁体中文",), "concise": ("简洁", "简短"), "detailed": ("详细",), "direct": ("直接", "直接坦诚"), "gentle": ("温和", "温和表达")}
_TOOLS = {"vscode": ("VS Code", "Visual Studio Code", "VSCode"), "vim": ("Vim",), "neovim": ("Neovim",), "idea": ("IntelliJ IDEA",), "pycharm": ("PyCharm",)}
_THEME = {"light": ("浅色", "浅色主题"), "dark": ("深色", "深色主题")}
_DOMAINS = {
    "文档": ("user.document.format", _FORMATS),
    "报告": ("user.report.format", _FORMATS),
    "笔记": ("user.notes.format", _FORMATS),
    "回复": ("user.communication", _COMMUNICATION),
    "回答": ("user.communication", _COMMUNICATION),
    "交流": ("user.communication", _COMMUNICATION),
    "界面": ("user.ui.theme", _THEME),
    "主题": ("user.ui.theme", _THEME),
    "编辑器": ("user.editor", _TOOLS),
    "开发工具": ("user.development.tool", _TOOLS),
    "操作系统": ("user.operating_system", {"windows10": ("Windows 10",), "windows11": ("Windows 11",), "windows": ("Windows",), "macos": ("macOS",), "linux": ("Linux",), "ubuntu": ("Ubuntu",), "debian": ("Debian",)}),
}


def normalized(text):
    return text.strip().rstrip("。.!！ ")


def user_fact(text):
    text = normalized(text)
    return _REQUEST.sub("", text), bool(_REQUEST.match(text))


def direct_fact_content(text):
    """Protocol construction: strip request prefix, preserve prose/punctuation."""
    return _REQUEST.sub("", text.strip())


def fact_identity(text):
    """Return a trusted topic/value pair, or None. No model permission fields."""
    fact, _ = user_fact(text)
    if _UNCERTAIN.search(fact) or _AUTHORITY.search(fact):
        return None
    match = re.fullmatch(r"(?:我的|这个)?项目(?:代号|名称)?(?:是|为|叫)\s*([\w\u4e00-\u9fff -]{1,40})", fact)
    if match:
        return "user.project.name", match[1].strip()
    match = re.fullmatch(r"我(?:希望|偏好|喜欢)回答(简洁|详细)", fact)
    if match:
        return "user.answer.length", match[1]
    match = re.fullmatch(r"(?:我的|我)(?P<topic>(?:工作)?(?:文档|报告|笔记)|回复|回答|交流|界面|主题|编辑器|开发工具|操作系统)(?:默认|通常|一直|长期)?(?:采用|使用|用|为|是|偏好|喜欢)(?P<value>.+?)(?:格式)?", fact)
    if not match:
        match = re.fullmatch(r"我(?:默认|通常|一直|长期)?(?:使用|用)(?P<value>.+?)(?:作为|当作)(?:我的)?(?P<topic>编辑器|开发工具|操作系统)", fact)
    if not match:
        return None
    topic = match["topic"].removeprefix("工作")
    key, values = _DOMAINS[topic]
    value = match["value"].strip().casefold()
    parsed = next((canonical for canonical, names in values.items() if value in [name.casefold() for name in names]), None)
    # Separate language/length/tone so independent preferences can coexist;
    # aliases for the same property still share one conflict key.
    if key == "user.communication" and parsed:
        if parsed in ("concise", "detailed"):
            return "user.answer.length", "简洁" if parsed == "concise" else "详细"
        key += ".language" if parsed in ("chinese", "english", "traditional") else ".tone"
    return (key, parsed) if parsed else None


def classify(candidate, sources):
    content = normalized(candidate["content"])
    text = "\n".join(source["content"] for source in sources)
    if candidate["sensitivity"] == "prohibited" or _CREDENTIAL.search(content + "\n" + text):
        return {"status": "Rejected", "reason": "ProhibitedCredential", "sensitivity": "prohibited", "key": None}
    if any(s["role"] != "user" for s in sources):
        return {"status": "Rejected", "reason": "AssistantIsNotUserEvidence", "sensitivity": "unknown", "key": None}
    actual = normalized(sources[0]["content"]) if len(sources) == 1 else ""
    fact, explicit = user_fact(actual)
    identity = fact_identity(fact) if (candidate["type"] == "Semantic" and candidate["evidence_kind"] == "user_statement" and content == normalized(fact)) else None
    sensitive = bool(_SENSITIVE.search(content + "\n" + text)) or candidate["sensitivity"] == "sensitive"
    # The model can raise caution, but low alone cannot make any unknown fact safe.
    low = identity is not None and not sensitive and candidate["sensitivity"] == "low" and not any(candidate.get(k) for k in ("valid_from", "valid_until", "scope"))
    return {"status": "Candidate", "reason": "ExplicitLowRisk" if explicit and low else "DirectLowRisk" if low else "ReviewRequired",
            "sensitivity": "low" if low else "sensitive" if sensitive else "unknown", "key": identity[0] if identity else None}


def decide(candidate, sources, mode, conflict=False):
    result = classify(candidate, sources)
    if result["status"] == "Rejected":
        return result
    if conflict:
        return result | {"reason": "ConflictReviewRequired"}
    if result["reason"] == "ExplicitLowRisk" or (mode == "Balanced" and result["reason"] == "DirectLowRisk"):
        return result | {"status": "Active"}
    return result
