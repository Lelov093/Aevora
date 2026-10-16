//! General file tools: Host-resolved roots, reviewed effects and durable receipts.
use crate::document_resources::digest;
use crate::tools::{local, Authority};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    os::windows::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};

pub const READS: &[&str] = &["list_files", "read_file", "search_files"];
pub const WRITES: &[&str] = &["write_file", "manage_files", "run_command"];
pub fn is_tool(op: &str) -> bool {
    READS.contains(&op) || WRITES.contains(&op)
}

fn text(v: &Value, key: &str) -> Result<String, String> {
    v[key]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("MissingToolField:{key}"))
}
pub fn resolve(scope: &Value, root: &str, relative: &str, write: bool) -> Result<PathBuf, String> {
    let index = root
        .strip_prefix("root")
        .and_then(|n| n.parse::<usize>().ok())
        .and_then(|n| n.checked_sub(1))
        .ok_or("InvalidRoot")?;
    let r = &scope["roots"][index];
    let base = Path::new(r["path"].as_str().ok_or("RootNotGranted")?);
    if write && r["mode"] != "write" {
        return Err("RootIsReadOnly".into());
    }
    let rel = Path::new(relative);
    if relative.len() > 500
        || relative.contains(':')
        || relative.contains('\\')
        || rel.is_absolute()
        || rel.components().any(|p| !matches!(p, Component::Normal(_))) && !relative.is_empty()
    {
        return Err("RelativePathRequired".into());
    }
    if !relative.is_empty()
        && relative
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == ".." || p.ends_with('.') || p.ends_with(' '))
    {
        return Err("RelativePathRequired".into());
    }
    if r["recursive"] != true && relative.split('/').count() > 1 {
        return Err("SubdirectoryNotGranted".into());
    }
    local(base)?;
    let target = base.join(rel);
    // Check every existing ancestor, including the root and any resource reparse point.
    let existing = if target.exists() {
        target.as_path()
    } else {
        target.parent().ok_or("ParentRequired")?
    };
    local(existing)?;
    if !existing.starts_with(base) {
        return Err("ResourceOutsideRoot".into());
    }
    Ok(target)
}
pub(crate) fn bytes(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    local(path)?;
    let mut file = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .custom_flags(0x00200000)
        .open(path)
        .map_err(|_| "FileUnavailable")?;
    if !file
        .metadata()
        .map_err(|_| "FileMetadataUnavailable")?
        .is_file()
    {
        return Err("FileRequired".into());
    }
    let mut result = Vec::new();
    Read::by_ref(&mut file)
        .take(limit + 1)
        .read_to_end(&mut result)
        .map_err(|_| "FileReadFailed")?;
    if result.len() as u64 > limit {
        return Err("FileCapacityExceeded".into());
    }
    Ok(result)
}
fn utf8(path: &Path) -> Result<String, String> {
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ![
        "txt", "md", "csv", "tsv", "json", "jsonl", "py", "js", "ts", "tsx", "jsx", "rs", "css",
        "html", "xml", "yaml", "yml", "toml", "ini", "log",
    ]
    .contains(&extension.as_str())
    {
        return Err("UnsupportedTextType".into());
    }
    let data = bytes(path, 1024 * 1024)?;
    let value = String::from_utf8(data).map_err(|_| "Utf8Required")?;
    if value.contains('\0') {
        return Err("BinaryContentNotReadable".into());
    }
    Ok(value)
}
fn matches(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().chars().collect();
    let s: Vec<char> = name.to_lowercase().chars().collect();
    let (mut i, mut j, mut star, mut mark) = (0, 0, None, 0);
    while j < s.len() {
        if i < p.len() && (p[i] == '?' || p[i] == s[j]) {
            i += 1;
            j += 1;
        } else if i < p.len() && p[i] == '*' {
            star = Some(i);
            i += 1;
            mark = j;
        } else if let Some(k) = star {
            i = k + 1;
            mark += 1;
            j = mark;
        } else {
            return false;
        }
    }
    while i < p.len() && p[i] == '*' {
        i += 1;
    }
    i == p.len()
}
fn walk(
    base: &Path,
    current: &Path,
    depth: usize,
    values: &mut Vec<Value>,
    truncated: &mut bool,
) -> Result<(), String> {
    local(current)?;
    // Bound enumeration before sorting, including directories with enormous entry counts.
    let mut entries = Vec::new();
    for item in fs::read_dir(current).map_err(|_| "DirectoryReadFailed")? {
        if values.len() + entries.len() >= 200 {
            *truncated = true;
            break;
        }
        entries.push(item.map_err(|_| "DirectoryEntryUnavailable")?);
    }
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if values.len() >= 200 {
            *truncated = true;
            break;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(|_| "FileMetadataUnavailable")?;
        if metadata.file_attributes() & 0x400 != 0 {
            continue;
        }
        let relative = path
            .strip_prefix(base)
            .map_err(|_| "ResourceOutsideRoot")?
            .to_string_lossy()
            .replace('\\', "/");
        let version = if metadata.is_file() && metadata.len() <= 8 * 1024 * 1024 {
            json!(digest(&bytes(&path, 8 * 1024 * 1024)?))
        } else {
            Value::Null
        };
        values.push(json!({"path":relative,"name":entry.file_name().to_string_lossy(),"kind":if metadata.is_dir(){"directory"}else{"file"},"bytes":metadata.len(),"modified":metadata.modified().ok().and_then(|v|v.duration_since(std::time::UNIX_EPOCH).ok()).map(|v|v.as_secs()),"version":version}));
        if metadata.is_dir() && depth > 0 {
            walk(base, &path, depth - 1, values, truncated)?;
        }
    }
    Ok(())
}

pub fn validate_scope(command: &mut Value) -> Result<(), String> {
    // Immutable inspection preserves omission. IndexMut would insert tools:null
    // into selected-file requests, which the Core correctly rejects.
    if command["payload"]["tools"].is_null() {
        return Ok(());
    }
    let scope = &mut command["payload"]["tools"];
    let roots = scope["roots"]
        .as_array_mut()
        .filter(|v| v.len() <= 4)
        .ok_or("ChooseAtMostFourRoots")?;
    let mut seen = std::collections::HashSet::new();
    for root in roots {
        let p = PathBuf::from(text(root, "path")?);
        local(&p)?;
        if !p.is_dir()
            || !matches!(root["mode"].as_str(), Some("read" | "write"))
            || !root["recursive"].is_boolean()
            || !root["auto_create"].is_boolean()
        {
            return Err("InvalidRootScope".into());
        }
        let canonical = fs::canonicalize(&p).map_err(|_| "RootUnavailable")?;
        if !seen.insert(canonical) {
            return Err("DuplicateRoot".into());
        }
        if root["auto_create"] == true && root["mode"] != "write" {
            return Err("AutoCreateRequiresWritableRoot".into());
        }
    }
    for url in scope["urls"].as_array().ok_or("UrlsRequired")? {
        crate::network::valid_url(url.as_str().ok_or("UrlRequired")?)?;
    }
    for program in scope["programs"].as_array().ok_or("ProgramsRequired")? {
        if !matches!(program.as_str(), Some("python" | "powershell")) {
            return Err("ProgramNotRegistered".into());
        }
    }
    Ok(())
}

impl Authority {
    pub fn general_step(
        &mut self,
        task: &Value,
        provider: &Value,
        project: &Path,
    ) -> Result<Value, String> {
        let grant = self.agent_scope(task, provider)?.clone();
        let scope = &grant["command"]["payload"]["tools"];
        let d = &task["current_step"]["definition"];
        let op = d["op"].as_str().ok_or("ToolRequired")?;
        let tid = task["task_id"].as_str().ok_or("TaskRequired")?;
        let sid = task["current_step"]["step_id"]
            .as_str()
            .ok_or("StepRequired")?;
        if READS.contains(&op) {
            self.charge_execution(&grant,sid,json!({}))?;
            let result=observe(scope,d).and_then(|observed|{self.execution_read(&grant,d,&observed)?;Ok(observed)});
            self.finish_execution_charge(&grant,sid)?;
            return result;
        }
        if !WRITES.contains(&op) {
            return Err("UnknownTool".into());
        }
        let mut stage = prepare(scope, d, project)?;
        stage["definition"] = d.clone();
        stage["task_id"] = task["task_id"].clone();
        stage["step_id"] = json!(sid);
        let mut next = self.value.clone();
        next["grants"][tid]["tool_stages"][sid] = stage.clone();
        self.save(next)?;
        let root_index = d["root"]
            .as_str()
            .and_then(|s| s.strip_prefix("root"))
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0);
        let destination_index = d["target_root"]
            .as_str()
            .and_then(|s| s.strip_prefix("root"))
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(root_index);
        let auto = scope["roots"][destination_index.saturating_sub(1)]["auto_create"] == true
            && (op == "write_file" && d["version"] == "new"
                || op == "manage_files" && matches!(d["action"].as_str(), Some("mkdir" | "copy")));
        Ok(json!({"status":"Success","preview":stage["preview"],"auto_execute":auto}))
    }
    pub fn begin_general(&mut self, task: &Value, project: &Path) -> Result<Value, String> {
        let tid = task["task_id"].as_str().ok_or("TaskRequired")?;
        let aid = task["agent_id"].as_str().ok_or("AgentRequired")?;
        let grant = self.grant(aid, tid)?.clone();
        self.check_parent(&grant)?;
        let step = &task["current_step"];
        let sid = step["step_id"].as_str().ok_or("StepRequired")?;
        let definition = &step["definition"];
        let action = &step["action"];
        let reviewed: Value =
            serde_json::from_str(action["body"].as_str().ok_or("ReviewedToolRequired")?)
                .map_err(|_| "ReviewedToolRequired")?;
        let old = &grant["tool_stages"][sid];
        if task["state"] != "Executing"
            || task["permission"] != 1
            || grant["enabled"] != true
            || old["definition"] != *definition
            || reviewed != *definition
        {
            return Err("ToolApprovalChanged".into());
        }
        let id = action["action_id"].as_str().ok_or("ActionRequired")?;
        if self.value["actions"].get(id).is_some() {
            return Err("ActionAlreadyStartedReconcileFirst".into());
        }
        let mut stage = prepare(&grant["command"]["payload"]["tools"], definition, project)?;
        if stage != {
            let mut original = old.clone();
            for key in ["definition", "task_id", "step_id"] {
                original.as_object_mut().unwrap().remove(key);
            }
            original
        } {
            return Err("ToolPreviewChanged".into());
        }
        let starts = grant["command_starts"].as_u64().unwrap_or(0);
        if definition["op"] == "run_command" && starts >= 4 {
            return Err("CommandStartLimit".into());
        }
        let mut targets = grant["tool_targets"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for output in stage["targets"].as_array().ok_or("TargetsRequired")? {
            if !targets.contains(output) {
                targets.push(output.clone());
            }
        }
        if targets.len() > 8 {
            return Err("FileChangeLimit".into());
        }
        stage["definition"] = definition.clone();
        stage["action_id"] = json!(id);
        stage["task_id"] = json!(tid);
        stage["agent_id"] = json!(aid);
        stage["work_dir"] = json!(self
            .path
            .parent()
            .ok_or("PrivateToolDirectoryUnavailable")?
            .join("general-work")
            .join(tid)
            .join(sid));
        self.charge_execution(&grant,id,json!({"changes":stage["targets"].as_array().map(Vec::len).unwrap_or(0),"commands":if definition["op"]=="run_command"{1}else{0}}))?;
        let mut next = self.value.clone();
        next["grants"][tid]["tool_targets"] = json!(targets);
        if definition["op"] == "run_command" {
            next["grants"][tid]["command_starts"] = json!(starts + 1);
        }
        next["actions"][id] = json!({"outcome":"Unknown","error":"ToolStarted","task_id":tid,"agent_id":aid,"stage":stage});
        self.save(next)?;
        if definition["op"] == "run_command" {
            crate::command_tools::reserve(tid)?;
        }
        Ok(stage)
    }
    pub fn finish_general(&mut self, stage: &Value, receipt: &Value) -> Result<(), String> {
        self.execution_products(stage,receipt)?;
        let id = stage["action_id"].as_str().ok_or("ActionRequired")?;
        let mut next = self.value.clone();
        next["actions"][id] = receipt.clone();
        next["actions"][id]["stage"] = stage.clone();
        self.save(next)
    }
    pub fn resolve_general(&self, task: &Value) -> Result<Value, String> {
        let tid = task["task_id"].as_str().ok_or("TaskRequired")?;
        self.grant(task["agent_id"].as_str().ok_or("AgentRequired")?, tid)?;
        let id = task["current_step"]["action"]["action_id"]
            .as_str()
            .ok_or("ActionRequired")?;
        let mut receipt = self.value["actions"]
            .get(id)
            .cloned()
            .unwrap_or(json!({"outcome":"NotExecuted","error":"NoNativeToolIntent"}));
        receipt.as_object_mut().unwrap().remove("stage");
        receipt.as_object_mut().unwrap().remove("log_directory");
        Ok(receipt)
    }
    pub fn preview_general(&self, task: &Value, id: &str, open: bool) -> Result<Value, String> {
        let grant = self.grant(
            task["agent_id"].as_str().ok_or("AgentRequired")?,
            task["task_id"].as_str().ok_or("TaskRequired")?,
        )?;
        if let Some(reference) = id.strip_prefix("tool-log:") {
            let (action, _) = reference.rsplit_once(':').ok_or("ToolLogRequired")?;
            let receipt = &self.value["actions"][action];
            if receipt["task_id"] != task["task_id"] {
                return Err("TaskLogNotGranted".into());
            }
            let folder = Path::new(
                receipt["stage"]["work_dir"]
                    .as_str()
                    .ok_or("ToolLogUnavailable")?,
            );
            let stdout = bytes(&folder.join("stdout.txt"), 1024 * 1024)?;
            let stderr = bytes(&folder.join("stderr.txt"), 1024 * 1024)?;
            if open {
                std::process::Command::new("explorer.exe")
                    .arg(folder)
                    .spawn()
                    .map_err(|_| "OpenLocationFailed")?;
            }
            return Ok(
                json!({"path":folder,"available":true,"content":format!("stdout:\n{}\nstderr:\n{}",String::from_utf8_lossy(&stdout),String::from_utf8_lossy(&stderr))}),
            );
        }
        let (action, index) = id
            .strip_prefix("tool:")
            .and_then(|v| v.rsplit_once(':'))
            .ok_or("ToolOutputRequired")?;
        let index = index.parse::<usize>().map_err(|_| "ToolOutputRequired")?;
        let receipt = &self.value["actions"][action];
        if receipt["task_id"] != task["task_id"] || receipt["outcome"] != "Success" {
            return Err("ConfirmedOutputRequired".into());
        }
        let product = &receipt["products"][index];
        let path = resolve(
            &grant["command"]["payload"]["tools"],
            product["root"].as_str().ok_or("RootRequired")?,
            product["path"].as_str().ok_or("PathRequired")?,
            false,
        )?;
        if digest(&bytes(&path, 8 * 1024 * 1024)?) != product["version"] {
            return Err("ArtifactChanged".into());
        }
        if open {
            // Open a location, never execute a model-generated script or executable.
            std::process::Command::new("explorer.exe")
                .arg(format!("/select,{}", path.display()))
                .spawn()
                .map_err(|_| "OpenLocationFailed")?;
        }
        Ok(json!({"path":path,"available":true,"content":utf8(&path).ok(),"opened_location":open}))
    }
}

pub fn scope_versions(scope:&Value)->Result<Value,String>{
    let mut result=json!({});
    for (i,r) in scope["roots"].as_array().ok_or("RootsRequired")?.iter().enumerate(){
        let base=Path::new(r["path"].as_str().ok_or("RootRequired")?);
        let mut entries=Vec::new();let mut truncated=false;
        walk(base,base,if r["recursive"]==true{3}else{0},&mut entries,&mut truncated)?;
        if truncated{return Err("SnapshotScopeExceedsCapacity".into());}
        for entry in entries{if entry["kind"]=="file"&&!entry["version"].is_null(){result[format!("root{}/{}",i+1,entry["path"].as_str().ok_or("PathRequired")?)]=entry["version"].clone();}}
    }
    Ok(result)
}

fn observe(scope: &Value, d: &Value) -> Result<Value, String> {
    let root = text(d, "root")?;
    let relative = text(d, "path")?;
    let path = resolve(scope, &root, &relative, false)?;
    if d["op"] == "read_file" {
        let content = utf8(&path)?;
        let chars: Vec<char> = content.chars().collect();
        let start = d["start"].as_u64().ok_or("ReadRangeRequired")? as usize;
        let length = d["length"]
            .as_u64()
            .filter(|n| (1..=2048).contains(n))
            .ok_or("ReadRangeRequired")? as usize;
        if start > chars.len() {
            return Err("ReadStartBeyondFile".into());
        }
        return Ok(
            json!({"status":"Success","root":root,"path":relative,"content":chars.iter().skip(start).take(length).collect::<String>(),"start":start,"end":(start+length).min(chars.len()),"total_characters":chars.len(),"complete":start==0&&length>=chars.len(),"version":digest(content.as_bytes())}),
        );
    }
    let index = root
        .strip_prefix("root")
        .unwrap()
        .parse::<usize>()
        .map_err(|_| "InvalidRoot")?
        - 1;
    let base = Path::new(
        scope["roots"][index]["path"]
            .as_str()
            .ok_or("RootRequired")?,
    );
    let depth = d["depth"]
        .as_u64()
        .unwrap_or(if scope["roots"][index]["recursive"] == true {
            3
        } else {
            0
        })
        .min(3) as usize;
    if depth > 0 && scope["roots"][index]["recursive"] != true {
        return Err("SubdirectoryNotGranted".into());
    }
    let mut entries = Vec::new();
    let mut truncated = false;
    walk(base, &path, depth, &mut entries, &mut truncated)?;
    let pattern = d["pattern"]
        .as_str()
        .filter(|v| !v.is_empty())
        .unwrap_or("*");
    let offset = d["offset"].as_u64().unwrap_or(0) as usize;
    if offset > 200 {
        return Err("PageOutsideCapacity".into());
    }
    if d["op"] == "list_files" {
        let matching: Vec<_> = entries
            .into_iter()
            .filter(|e| matches(pattern, e["name"].as_str().unwrap_or("")))
            .collect();
        let next = if offset + 50 < matching.len() {
            Some(offset + 50)
        } else {
            None
        };
        return Ok(
            json!({"status":"Success","root":root,"entries":matching.into_iter().skip(offset).take(50).collect::<Vec<_>>(),"next_offset":next,"truncated":truncated}),
        );
    }
    let query = text(d, "query")?;
    if query.is_empty() || query.chars().count() > 200 {
        return Err("SearchQueryRequired".into());
    }
    let mut hits = Vec::new();
    let mut skipped = 0;
    'files: for e in entries {
        if e["kind"] != "file" || !matches(pattern, e["name"].as_str().unwrap_or("")) {
            continue;
        }
        let p = resolve(scope, &root, e["path"].as_str().unwrap(), false)?;
        let content = match utf8(&p) {
            Ok(s) => s,
            Err(_) => {
                skipped += 1;
                continue;
            }
        };
        for (i, line) in content.lines().enumerate() {
            if line.contains(&query) {
                if hits.len() >= 100 {
                    truncated = true;
                    break 'files;
                }
                hits.push(json!({"path":e["path"],"line":i+1,"content":line.chars().take(500).collect::<String>(),"version":digest(content.as_bytes())}));
            }
        }
    }
    let next = if offset + 50 < hits.len() {
        Some(offset + 50)
    } else {
        None
    };
    Ok(
        json!({"status":"Success","root":root,"matches":hits.into_iter().skip(offset).take(50).collect::<Vec<_>>(),"next_offset":next,"truncated":truncated,"skipped_unreadable":skipped}),
    )
}

fn prepare(scope: &Value, d: &Value, project: &Path) -> Result<Value, String> {
    let op = text(d, "op")?;
    let root = text(d, "root")?;
    let relative = text(d, "path")?;
    let path = resolve(
        scope,
        &root,
        &relative,
        op == "write_file" || op == "manage_files" && d["action"] != "copy",
    )?;
    let mut stage = json!({"scope":scope,"path":path,"targets":[],"preview":{}});
    if op == "write_file" {
        let version = text(d, "version")?;
        let old = if version == "new" {
            if path.exists() {
                return Err("TargetAlreadyExists".into());
            }
            String::new()
        } else {
            let old = utf8(&path)?;
            if digest(old.as_bytes()) != version {
                return Err("FileVersionChanged".into());
            }
            old
        };
        let mut new = if version == "new" {
            text(d, "body")?
        } else {
            old.clone()
        };
        if version != "new" {
            for patch in d["patch"].as_array().ok_or("PatchRequired")? {
                let from = text(patch, "old")?;
                if from.is_empty() || new.matches(&from).count() != 1 {
                    return Err("PatchMustMatchExactlyOnce".into());
                }
                new = new.replacen(&from, &text(patch, "new")?, 1);
            }
        }
        if new.len() > 1024 * 1024 {
            return Err("OutputCapacityExceeded".into());
        }
        // Validate text type even for new targets.
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if ![
            "txt", "md", "csv", "tsv", "json", "jsonl", "py", "js", "ts", "tsx", "jsx", "rs",
            "css", "html", "xml", "yaml", "yml", "toml", "ini", "log",
        ]
        .contains(&ext.as_str())
        {
            return Err("UnsupportedTextType".into());
        }
        stage["old"] = json!(old);
        stage["body"] = json!(new);
        stage["targets"] = json!([{"root":root,"path":relative}]);
        stage["preview"] =
            json!({"operation":op,"path":path,"before":old,"after":new,"version":version});
    } else if op == "manage_files" {
        let action = text(d, "action")?;
        if action == "mkdir" {
            if path.exists() || d["version"] != "new" {
                return Err("TargetAlreadyExists".into());
            }
            stage["targets"] = json!([{"root":root,"path":relative}]);
        } else if action == "copy" || action == "move" {
            if action == "move" && d["root"] != d["target_root"] {
                return Err("MoveOutsideRoot".into());
            }
            let target = resolve(scope, &text(d, "target_root")?, &text(d, "target")?, true)?;
            if target.exists() {
                return Err("TargetAlreadyExists".into());
            }
            let data = bytes(&path, 8 * 1024 * 1024)?;
            if digest(&data) != d["version"] {
                return Err("FileVersionChanged".into());
            }
            stage["target"] = json!(target);
            stage["source_version"] = d["version"].clone();
            stage["targets"] = json!([{"root":d["target_root"],"path":d["target"]}]);
            if action == "move" {
                stage["targets"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"root":root,"path":relative}));
            }
        } else {
            return Err("UnsupportedFileOperation".into());
        }
        stage["preview"] = json!({"operation":action,"source":path,"target":stage["target"],"version":d["version"]});
    } else if op == "run_command" {
        if !path.is_dir() {
            return Err("CommandDirectoryRequired".into());
        }
        let program = text(d, "program")?;
        if !scope["programs"]
            .as_array()
            .ok_or("ProgramNotGranted")?
            .contains(&json!(program))
        {
            return Err("ProgramNotGranted".into());
        }
        let executable = crate::command_tools::program(&program, project)?;
        let inputs = d["inputs"]
            .as_array()
            .filter(|v| v.len() <= 8)
            .ok_or("DeclaredInputsRequired")?;
        for input in inputs {
            let selected = resolve(scope, &text(input, "root")?, &text(input, "path")?, false)?;
            if digest(&bytes(&selected, 8 * 1024 * 1024)?) != input["version"] {
                return Err("CommandInputVersionChanged".into());
            }
        }
        stage["inputs"] = json!(inputs);
        let mut outputs = Vec::new();
        for output in d["outputs"].as_array().ok_or("DeclaredOutputsRequired")? {
            let target = resolve(scope, &text(output, "root")?, &text(output, "path")?, true)?;
            if output["version"] == "new" {
                if target.exists() {
                    return Err("TargetAlreadyExists".into());
                }
            } else if digest(&bytes(&target, 8 * 1024 * 1024)?) != output["version"] {
                return Err("FileVersionChanged".into());
            }
            outputs.push(json!({"root":output["root"],"path":output["path"],"version":output["version"],"absolute":target}));
        }
        stage["executable"] = json!(executable);
        stage["outputs"] = json!(outputs);
        stage["targets"] = json!(outputs
            .iter()
            .map(|v| json!({"root":v["root"],"path":v["path"]}))
            .collect::<Vec<_>>());
        stage["preview"] = json!({"operation":op,"program":executable,"args":d["args"],"script":d["script"],"cwd":path,"inputs":inputs,"outputs":outputs,"timeout_seconds":scope["command_timeout_seconds"],"is_sandboxed":false});
    } else {
        return Err("UnknownTool".into());
    }
    Ok(stage)
}

pub fn perform(stage: &Value) -> Value {
    let d = &stage["definition"];
    if d["op"] == "run_command" {
        return crate::command_tools::run(stage);
    }
    let mut changed = false;
    let result = (|| -> Result<Value, String> {
        let checked = resolve(
            &stage["scope"],
            d["root"].as_str().ok_or("RootRequired")?,
            d["path"].as_str().ok_or("PathRequired")?,
            d["op"] == "write_file" || d["action"] != "copy",
        )?;
        let path = checked.as_path();
        let (root, relative, target) = if d["op"] == "write_file" {
            let mut opts = fs::OpenOptions::new();
            opts.read(true)
                .write(true)
                .share_mode(0)
                .custom_flags(0x00200000);
            if d["version"] == "new" {
                opts.create_new(true);
            } else {
                local(path)?;
            }
            let mut file = opts.open(path).map_err(|_| "FileLockedOrExists")?;
            if d["version"] != "new" {
                let mut old = Vec::new();
                Read::by_ref(&mut file)
                    .take(1024 * 1024 + 1)
                    .read_to_end(&mut old)
                    .map_err(|_| "FileReadFailed")?;
                if digest(&old) != d["version"] {
                    return Err("FileVersionChanged".into());
                }
                let folder = Path::new(
                    stage["work_dir"]
                        .as_str()
                        .ok_or("PrivateDirectoryRequired")?,
                );
                fs::create_dir_all(folder).map_err(|_| "RecoveryCopyUnavailable")?;
                fs::write(folder.join("before.txt"), old).map_err(|_| "RecoveryCopyUnavailable")?;
            }
            changed = true;
            let body = stage["body"].as_str().ok_or("BodyRequired")?.as_bytes();
            file.seek(SeekFrom::Start(0))
                .and_then(|_| file.write_all(body))
                .and_then(|_| file.set_len(body.len() as u64))
                .and_then(|_| file.sync_all())
                .map_err(|_| "FileWriteIncomplete")?;
            drop(file);
            if bytes(path, 1024 * 1024)? != body {
                return Err("SavedContentMismatch".into());
            }
            (d["root"].clone(), d["path"].clone(), path.to_path_buf())
        } else if d["action"] == "mkdir" {
            fs::create_dir(path).map_err(|_| "DirectoryCreateFailed")?;
            changed = true;
            return Ok(json!({"products":[],"verification":"DirectoryExists"}));
        } else {
            let target = Path::new(stage["target"].as_str().ok_or("TargetRequired")?);
            let data = bytes(path, 8 * 1024 * 1024)?;
            if digest(&data) != d["version"] {
                return Err("FileVersionChanged".into());
            }
            if d["action"] == "copy" {
                let mut out = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(target)
                    .map_err(|_| "TargetAlreadyExists")?;
                changed = true;
                out.write_all(&data)
                    .and_then(|_| out.sync_all())
                    .map_err(|_| "FileCopyIncomplete")?;
                drop(out);
            } else {
                // Windows rename fails if the destination exists; never use replacement semantics.
                fs::rename(path, target).map_err(|_| "FileMoveFailed")?;
                changed = true;
            }
            if bytes(target, 8 * 1024 * 1024)? != data || d["action"] == "move" && path.exists() {
                return Err("FileChangeUnconfirmed".into());
            }
            (
                d["target_root"].clone(),
                d["target"].clone(),
                target.to_path_buf(),
            )
        };
        let data = bytes(&target, 8 * 1024 * 1024)?;
        Ok(
            json!({"products":[{"root":root,"path":relative,"version":digest(&data),"bytes":data.len()}],"bytes_written":data.len(),"verification":"ReadBackVerified"}),
        )
    })();
    let mut receipt = match result {
        Ok(v) => v,
        Err(error) => json!({"outcome":if changed{"Unknown"}else{"NotExecuted"},"error":error}),
    };
    if receipt["outcome"].is_null() {
        receipt["outcome"] = json!("Success");
    }
    for key in ["action_id", "task_id", "agent_id"] {
        receipt[key] = stage[key].clone();
    }
    receipt
}
