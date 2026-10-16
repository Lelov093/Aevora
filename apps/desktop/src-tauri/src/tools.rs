// Native authority for the deliberately bounded P1 file workflow.
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    os::windows::fs::{MetadataExt, OpenOptionsExt},
    path::{Component, Path, PathBuf},
};

pub struct Authority {
    pub(crate) path: PathBuf,
    pub(crate) value: Value,
}
fn denied(message: &str) -> String {
    json!({"error":{"code":"Forbidden","message":message}}).to_string()
}

pub(crate) fn local(path: &Path) -> Result<(), String> {
    let text = path
        .to_str()
        .ok_or_else(|| denied("Path must be Unicode"))?;
    if !path.is_absolute()
        || text.starts_with("\\\\")
        || text.get(2..).unwrap_or("").contains(':')
        || path.components().any(|c| matches!(c, Component::ParentDir))
    {
        return Err(denied(
            "Choose an absolute local path without traversal, device or alternate stream syntax",
        ));
    }
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor)
            .map_err(|_| denied("Selected resource or parent is unavailable"))?;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(denied("Reparse resources are outside this file permission"));
        }
    }
    Ok(())
}
pub fn source(path: &str) -> Result<String, String> {
    let p = Path::new(path);
    local(p)?;
    if !p.is_file()
        || !matches!(
            p.extension()
                .and_then(|v| v.to_str())
                .map(str::to_lowercase)
                .as_deref(),
            Some("txt" | "md")
        )
    {
        return Err(denied("Select UTF-8 .txt or .md files"));
    }
    Ok(p.to_string_lossy().into_owned())
}
pub fn destination(path: &str) -> Result<String, String> {
    let p = Path::new(path);
    let parent = p
        .parent()
        .ok_or_else(|| denied("Choose a local output directory"))?;
    local(parent)?;
    if !p.is_absolute()
        || path.get(2..).unwrap_or("").contains(':')
        || path.starts_with("\\\\")
        || p.components().any(|c| matches!(c, Component::ParentDir))
        || !matches!(
            p.extension()
                .and_then(|v| v.to_str())
                .map(str::to_lowercase)
                .as_deref(),
            Some("txt" | "md")
        )
    {
        return Err(denied("Output must be a new local .md or .txt file"));
    }
    if p.exists() {
        return Err(denied(
            "The destination already exists; choose a new filename",
        ));
    }
    Ok(path.into())
}
pub(crate) fn read(path: &str, limit: usize) -> Result<String, String> {
    read_exact(path, limit).map(|s| s.trim_start_matches('\u{feff}').to_string())
}
pub(crate) fn read_exact(path: &str, limit: usize) -> Result<String, String> {
    source(path)?;
    let file = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .custom_flags(0x00200000)
        .open(path)
        .map_err(|_| denied("Selected file cannot be opened"))?;
    let metadata = file
        .metadata()
        .map_err(|_| denied("Cannot inspect selected file"))?;
    if metadata.file_attributes() & 0x400 != 0 || metadata.len() > limit as u64 {
        return Err(denied(
            "File exceeds configured input capacity or is a reparse resource",
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| denied("Selected file could not be read"))?;
    if bytes.len() > limit {
        return Err(denied("File exceeds configured input capacity"));
    }
    String::from_utf8(bytes)
        .map_err(|_| denied("Selected file must be UTF-8; no implicit decoding"))
}

impl Authority {
    pub fn load(data: &Path) -> Result<Self, String> {
        let path = data.join("task-authority.json");
        let value = if path.exists() {
            serde_json::from_slice(
                &fs::read(&path).map_err(|_| denied("Cannot read file permissions"))?,
            )
            .map_err(|_| denied("File permissions could not be parsed"))?
        } else {
            json!({"grants":{},"actions":{}})
        };
        if !value["grants"].is_object() || !value["actions"].is_object() {
            return Err(denied("Invalid native file permissions"));
        }
        Ok(Self { path, value })
    }
    pub(crate) fn save(&mut self, next: Value) -> Result<(), String> {
        let tmp = self.path.with_extension("tmp");
        let mut file =
            fs::File::create(&tmp).map_err(|_| denied("Cannot save native action authority"))?;
        file.write_all(&serde_json::to_vec(&next).unwrap())
            .and_then(|_| file.sync_all())
            .map_err(|_| denied("Cannot persist native action authority"))?;
        drop(file);
        fs::rename(tmp, &self.path)
            .map_err(|_| denied("Cannot replace native action authority"))?;
        self.value = next;
        Ok(())
    }
    pub fn create(&mut self, c: &Value, provider: &Value) -> Result<Value, String> {
        let tid = c["command_id"]
            .as_str()
            .ok_or_else(|| denied("Task ID required"))?;
        if let Some(grant) = self.value["grants"].get(tid) {
            if grant["request"] != *c {
                return Err(denied("Task ID reused with different resources"));
            }
            return Ok(grant["command"].clone());
        }
        let mut normalized = c.clone();
        let p = &mut normalized["payload"];
        if p["allow_file_outbound"] != true
            || c["agent_id"].as_str().filter(|s| !s.is_empty()).is_none()
        {
            return Err(denied(
                "Explicit Agent and file outbound permission required",
            ));
        }
        let paths = p["sources"]
            .as_array()
            .filter(|v| !v.is_empty())
            .ok_or_else(|| denied("Select files"))?;
        let mut sources = Vec::new();
        for item in paths {
            sources.push(source(
                item.as_str().ok_or_else(|| denied("Path required"))?,
            )?);
        }
        p["sources"] = json!(sources);
        if c["type"] == "CreatePlannedTask" {
            let outputs = p["outputs"]
                .as_array_mut()
                .filter(|v| !v.is_empty() && v.len() <= 2)
                .ok_or_else(|| denied("Select one or two output files"))?;
            let mut used = std::collections::HashSet::new();
            for output in outputs {
                let path = destination(
                    output["path"]
                        .as_str()
                        .ok_or_else(|| denied("Output path required"))?,
                )?;
                if !used.insert(path.to_lowercase().replace('/', "\\")) {
                    return Err(denied("Output paths must be distinct"));
                }
                output["path"] = json!(path);
            }
        } else {
            p["output_path"] = json!(destination(
                p["output_path"]
                    .as_str()
                    .ok_or_else(|| denied("Output path required"))?
            )?);
        }
        let mut next = self.value.clone();
        next["grants"][tid] = json!({"request":c,"command":normalized,"agent_id":c["agent_id"],"enabled":true,
            "provider":binding(provider)});
        self.save(next)?;
        Ok(normalized)
    }
    pub fn create_network(&mut self, c: &Value, provider: &Value, search: &Value) -> Result<Value, String> {
        let tid = c["command_id"].as_str().ok_or("Task required")?;
        if let Some(grant) = self.value["grants"].get(tid) {
            if grant["request"] != *c { return Err(denied("Task ID reused")); }
            return Ok(grant["command"].clone());
        }
        if c["payload"]["allow_model_outbound"] != true || provider["chat_allowed"] != true
            || search["allowed"] != true || search["credential_present"] != true || c["agent_id"].as_str().is_none() {
            return Err(denied("Explicit task model and search purposes required"));
        }
        let mut command = c.clone();
        let outputs = command["payload"]["outputs"].as_array_mut().filter(|o| !o.is_empty() && o.len() <= 2).ok_or("Choose outputs")?;
        let mut paths = std::collections::HashSet::new();
        for output in outputs {
            let path = destination(output["path"].as_str().ok_or("Path required")?)?;
            if !paths.insert(path.to_lowercase().replace('/', "\\")) { return Err(denied("Distinct output paths required")); }
            output["path"] = json!(path);
        }
        let mut next = self.value.clone();
        next["grants"][tid] = json!({"request":c,"command":command,"agent_id":c["agent_id"],"enabled":true,
            "provider":binding(provider),"search_revision":search["revision"],"queries":[],"urls":[],"redirect_hosts":{},"search_calls_started":0});
        self.save(next)?;
        Ok(command)
    }
    pub fn review_network(&mut self, task: &Value, command: &Value) -> Result<(), String> {
        let aid = task["agent_id"].as_str().ok_or("Agent required")?;
        let tid = task["task_id"].as_str().ok_or("Task required")?;
        let grant = self.grant(aid, tid)?;
        if grant["enabled"] != true || task["permission"] != 1 || task["revision"] != command["expected_revision"] {
            return Err(denied("Current task permission and review required"));
        }
        let mut next = self.value.clone();
        match command["type"].as_str() {
            Some("ApproveTaskPlan") if task["state"] == "AwaitingPlanApproval" => {
                let steps = task["runs"][0]["plan"]["steps"].as_array().ok_or("Plan required")?;
                next["grants"][tid]["queries"] = json!(steps.iter().filter(|s| s["op"] == "search").map(|s| s["query"].clone()).collect::<Vec<_>>());
            }
            Some("SelectNetworkSources") if task["state"] == "AwaitingSources" => {
                let ids = command["payload"]["source_ids"].as_array().filter(|v| !v.is_empty() && v.len() <= 6).ok_or("Select sources")?;
                let candidates = task["candidates"].as_array().ok_or("Search results required")?;
                let mut urls = Vec::new();
                for id in ids {
                    let candidate = candidates.iter().find(|s| &s["source_id"] == id).ok_or("Source is outside actual search results")?;
                    crate::network::valid_url(candidate["url"].as_str().ok_or("Source URL required")?)?;
                    urls.push(candidate["url"].clone());
                }
                next["grants"][tid]["urls"] = json!(urls);
            }
            Some("ApproveNetworkRedirect") if task["state"] == "AwaitingRedirectApproval" => {
                let url = crate::network::valid_url(task["current_step"]["result"]["redirect_url"].as_str().ok_or("Redirect URL required")?)?;
                let original = task["current_step"]["definition"]["url"].as_str().ok_or("Original source required")?;
                if next["grants"][tid]["redirect_hosts"].get(original).is_none() { next["grants"][tid]["redirect_hosts"][original] = json!([]); }
                next["grants"][tid]["redirect_hosts"][original].as_array_mut().ok_or("Redirect authority unavailable")?.push(json!(url.host_str()));
            }
            _ => return Err(denied("No current network review")),
        }
        self.save(next)
    }
    pub fn begin_network(&mut self, task: &Value, provider: &Value, search: &Value, id: &str) -> Result<Vec<String>, String> {
        if task["kind"]=="agent" {return self.begin_agent_network(task,provider,search,id);}
        let aid = task["agent_id"].as_str().ok_or("Agent required")?;
        let tid = task["task_id"].as_str().ok_or("Task required")?;
        self.outbound(aid, tid, provider)?;
        let grant = self.grant(aid, tid)?;
        if task["state"] != "Running" || task["permission"] != 1 || task["runs"][0]["plan_approved"] != 1
            || search["allowed"] != true || search["revision"] != grant["search_revision"] {
            return Err(denied("Current approved network purposes required"));
        }
        let d = &task["current_step"]["definition"];
        let permitted = if d["op"] == "search" {
            grant["queries"].as_array().map(|a| a.contains(&d["query"]))
        } else if d["op"] == "read_web" {
            grant["urls"].as_array().map(|a| a.contains(&d["url"]))
        } else { None };
        if permitted != Some(true) || self.value["actions"].get(id).is_some() { return Err(denied("Unapproved or repeated network request")); }
        let calls = grant["search_calls_started"].as_u64().unwrap_or(0);
        if d["op"] == "search" && calls >= 3 { return Err("SearchRequestLimit".into()); }
        let hosts = grant["redirect_hosts"].get(d["url"].as_str().unwrap_or("")).and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
        let mut next = self.value.clone();
        if d["op"] == "search" { next["grants"][tid]["search_calls_started"] = json!(calls+1); }
        next["actions"][id] = json!({"agent_id":aid,"task_id":tid,"kind":d["op"],"state":"Unknown","error":"NetworkRequestStarted"});
        self.save(next)?;
        Ok(hosts)
    }
    pub fn finish_network(&mut self, id: &str, metadata: &Value) -> Result<(), String> {
        let tid=self.value["actions"][id]["task_id"].as_str().unwrap_or("");
        let grant=self.value["grants"][tid].clone();
        self.finish_execution_charge(&grant,id)?;
        let mut next = self.value.clone();
        if next["actions"].get(id).is_none() { return Err(denied("Unknown network request")); }
        next["actions"][id]["state"] = json!("Finished");
        next["actions"][id]["metadata"] = metadata.clone();
        self.save(next)
    }
    pub(crate) fn grant(&self, aid: &str, tid: &str) -> Result<&Value, String> {
        let grant = self.value["grants"]
            .get(tid)
            .ok_or_else(|| denied("Native file permission unavailable"))?;
        if grant["agent_id"] != aid {
            return Err(denied("File permission belongs to another Agent"));
        }
        Ok(grant)
    }
    pub fn outbound(&self, aid: &str, tid: &str, provider: &Value) -> Result<(), String> {
        let grant = self.grant(aid, tid)?;
        self.check_parent(grant)?;
        if grant["enabled"] != true
            || grant["provider"] != binding(provider)
            || provider["chat_allowed"] != true
        {
            return Err(denied("File outbound permission is revoked or belongs to another provider revision; create a new task to authorize it"));
        }
        Ok(())
    }
    pub fn files(&self, aid: &str, tid: &str, provider: &Value) -> Result<Value, String> {
        self.outbound(aid, tid, provider)?;
        let grant = self.grant(aid, tid)?;
        let limit = provider["max_input_tokens"].as_u64().unwrap_or(4096) as usize * 4;
        let mut files = Vec::new();
        let mut size = 0;
        for path in grant["command"]["payload"]["sources"].as_array().unwrap() {
            let path = path.as_str().unwrap();
            let content = read(path, limit.saturating_sub(size))?;
            size += content.len();
            files.push(json!({"path":path,"content":content}));
        }
        Ok(json!(files))
    }
    pub fn revoke(&mut self, aid: &str, tid: &str) -> Result<(), String> {
        self.grant(aid, tid)?;
        let mut next = self.value.clone();
        next["grants"][tid]["enabled"] = json!(false);
        self.save(next)
    }
    pub fn read_step(&self, task: &Value, provider: &Value) -> Result<Value, String> {
        if task["kind"]=="agent" {return self.read_agent_step(task,provider);}
        let aid = task["agent_id"]
            .as_str()
            .ok_or_else(|| denied("Agent required"))?;
        let tid = task["task_id"]
            .as_str()
            .ok_or_else(|| denied("Task required"))?;
        self.outbound(aid, tid, provider)?;
        if task["state"] != "Running"
            || task["runs"][0]["plan_approved"] != 1
            || task["permission"] != 1
        {
            return Err(denied("An approved current plan is required"));
        }
        let step = &task["current_step"];
        if step["definition"]["op"] != "read" {
            return Err(denied("Native read step required"));
        }
        let resource = step["definition"]["resource"]
            .as_str()
            .ok_or_else(|| denied("Resource required"))?;
        let grant = self.grant(aid, tid)?;
        let (index, is_output) = if let Some(n) = resource.strip_prefix("source") {
            (n, false)
        } else if let Some(n) = resource.strip_prefix("output") {
            (n, true)
        } else {
            return Err(denied("Unknown resource"));
        };
        let index = index
            .parse::<usize>()
            .ok()
            .and_then(|i| i.checked_sub(1))
            .ok_or_else(|| denied("Invalid resource"))?;
        let path = if is_output {
            &grant["command"]["payload"]["outputs"][index]["path"]
        } else {
            &grant["command"]["payload"]["sources"][index]
        };
        let path = path
            .as_str()
            .ok_or_else(|| denied("Resource outside permission"))?;
        let limit = provider["max_input_tokens"].as_u64().unwrap_or(4096) as usize * 4;
        let content = if is_output {
            let writer = task["runs"][0]["steps"]
                .as_array()
                .unwrap()
                .iter()
                .find(|s| {
                    s["definition"]["op"] == "write"
                        && s["definition"]["output"] == resource
                        && s["state"] == "Completed"
                })
                .ok_or_else(|| denied("Output has no confirmed write"))?;
            let content = read_exact(path, limit)?;
            if writer["action"]["receipt"]["outcome"] != "Success"
                || writer["action"]["body"].as_str() != Some(&content)
            {
                return Err("ArtifactChanged".into());
            }
            content
        } else {
            read(path, limit)?
        };
        Ok(json!({"path":path,"content":content}))
    }
    pub fn execute(&mut self, task: &Value) -> Result<Value, String> {
        let aid = task["agent_id"]
            .as_str()
            .ok_or_else(|| denied("Agent required"))?;
        let tid = task["task_id"]
            .as_str()
            .ok_or_else(|| denied("Task required"))?;
        let grant = self.grant(aid, tid)?;
        if grant["enabled"] != true
            || task["permission"] != 1
            || task["state"] != "Executing"
            || !(grant["command"]["payload"]["output_path"] == task["output_path"]
                || grant["command"]["payload"]["outputs"]
                    .as_array()
                    .map(|o| o.iter().any(|v| v["path"] == task["output_path"]))
                    .unwrap_or(false))
        {
            return Err(denied(
                "Approved write is outside the current resource permission",
            ));
        }
        let action = &task["runs"][0]["action"];
        let id = action["action_id"]
            .as_str()
            .ok_or_else(|| denied("Current proposal required"))?;
        if self.value["actions"].get(id).is_some() {
            return Err(denied(
                "This action has already started; reconcile the recorded outcome",
            ));
        }
        let body = action["body"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| denied("Reviewed body unavailable"))?;
        let path = task["output_path"].as_str().unwrap();
        let mut next = self.value.clone();
        next["actions"][id] = json!({"agent_id":aid,"task_id":tid,"path":path,"outcome":"Unknown","error":"WriteStarted"});
        self.save(next)?; // Durable before opening a file: never replay an uncertain write.
        let mut receipt = json!({"agent_id":aid,"task_id":tid,"action_id":id,"path":path,"outcome":"NotExecuted"});
        match destination(path).and_then(|_| {
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .share_mode(0)
                .open(path)
                .map_err(|_| denied("Create-only output could not be opened"))
        }) {
            Ok(mut file) => {
                if file
                    .write_all(body.as_bytes())
                    .and_then(|_| file.sync_all())
                    .is_ok()
                {
                    receipt["outcome"] = json!("Success");
                    receipt["bytes_written"] = json!(body.len());
                } else {
                    receipt["outcome"] = json!("Unknown");
                    receipt["error"] = json!("WriteIncomplete");
                }
            }
            Err(_) => {
                receipt["error"] = json!("ResourceUnavailableOrExists");
            }
        }
        let mut next = self.value.clone();
        next["actions"][id] = receipt.clone();
        self.save(next)?;
        Ok(receipt)
    }
    pub fn resolve(&self, task: &Value) -> Result<Value, String> {
        let aid = task["agent_id"].as_str().unwrap();
        let tid = task["task_id"].as_str().unwrap();
        self.grant(aid, tid)?;
        let action = &task["runs"][0]["action"];
        let id = action["action_id"]
            .as_str()
            .ok_or_else(|| denied("No action to reconcile"))?;
        let mut receipt = self.value["actions"]
            .get(id)
            .cloned()
            .unwrap_or(json!({"outcome":"NotExecuted","error":"NoNativeWriteIntent"}));
        if receipt["outcome"] == "Success" || receipt["outcome"] == "Unknown" {
            let body = action["body"].as_str().unwrap_or("");
            let matches = !body.is_empty()
                && read_exact(task["output_path"].as_str().unwrap(), 131072)
                    .map(|s| s == body)
                    .unwrap_or(false);
            receipt["outcome"] = json!(if matches { "Success" } else { "Unknown" });
            receipt["reconciled_by_user"] = json!(true);
            receipt["content_matches_proposal"] = json!(matches);
            receipt["error"] = if matches {
                Value::Null
            } else {
                json!("ArtifactChangedOrUnavailable")
            };
        }
        Ok(receipt)
    }
    pub fn preview(&self, task: &Value) -> Result<Value, String> {
        self.grant(
            task["agent_id"].as_str().unwrap(),
            task["task_id"].as_str().unwrap(),
        )?;
        let path = task["output_path"].as_str().unwrap();
        match read(path, 131072) {
            Ok(content) => Ok(json!({"path":path,"available":true,"content":content})),
            Err(_) => {
                Ok(json!({"path":path,"available":false,"error":"ArtifactChangedOrUnavailable"}))
            }
        }
    }
}
pub fn binding(config: &Value) -> Value {
    json!({"base_url":config["base_url"],"model":config["model"],"revision":config["revision"]})
}

pub fn choose(kind: &str) -> Result<Value, String> {
    use std::{os::windows::process::CommandExt, process::Command};
    let script = match kind {
        "directory" => "Add-Type -AssemblyName System.Windows.Forms; $dlg=New-Object System.Windows.Forms.FolderBrowserDialog; if($dlg.ShowDialog() -eq 'OK'){ConvertTo-Json -Compress -InputObject @($dlg.SelectedPath)}else{'[]'}",
        "sources" => "Add-Type -AssemblyName System.Windows.Forms; $dlg=New-Object System.Windows.Forms.OpenFileDialog; $dlg.Filter='UTF-8 Text (*.md;*.txt)|*.md;*.txt'; $dlg.Multiselect=$true; if($dlg.ShowDialog() -eq 'OK'){ConvertTo-Json -Compress -InputObject @($dlg.FileNames)}else{'[]'}",
        "output" => "Add-Type -AssemblyName System.Windows.Forms; $dlg=New-Object System.Windows.Forms.SaveFileDialog; $dlg.Filter='Markdown (*.md)|*.md|Text (*.txt)|*.txt'; $dlg.FileName='report.md'; if($dlg.ShowDialog() -eq 'OK'){ConvertTo-Json -Compress -InputObject @($dlg.FileName)}else{'[]'}",
        "documents" => "Add-Type -AssemblyName System.Windows.Forms; $dlg=New-Object System.Windows.Forms.OpenFileDialog; $dlg.Filter='Documents (*.docx;*.xlsx;*.md;*.txt)|*.docx;*.xlsx;*.md;*.txt'; if($dlg.ShowDialog() -eq 'OK'){ConvertTo-Json -Compress -InputObject @($dlg.FileName)}else{'[]'}",
        "document-output" => "Add-Type -AssemblyName System.Windows.Forms; $dlg=New-Object System.Windows.Forms.SaveFileDialog; $dlg.Filter='Word (*.docx)|*.docx|Excel (*.xlsx)|*.xlsx'; $dlg.FileName='document.docx'; if($dlg.ShowDialog() -eq 'OK'){ConvertTo-Json -Compress -InputObject @($dlg.FileName)}else{'[]'}",
        _ => return Err(denied("Unsupported file picker")),
    };
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-STA",
            "-Command",
            &format!("[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); {script}"),
        ])
        .creation_flags(0x08000000)
        .output()
        .map_err(|_| denied("File picker unavailable"))?;
    if !output.status.success() {
        return Err(denied("File picker failed"));
    }
    serde_json::from_slice(&output.stdout).map_err(|_| denied("File selection could not be read"))
}
