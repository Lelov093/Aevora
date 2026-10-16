//! Host-owned selected document previews and conditional writes.
use crate::document_resources::{
    bytes, cell, digest, identity, inside, office_open_marker, range_bounds, read_document,
    valid_word_id,
};
pub use crate::document_resources::{inspect_selection, validate_resources};
use crate::{
    office,
    tools::{local, Authority},
};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    os::windows::{fs::OpenOptionsExt, process::CommandExt},
    path::{Path, PathBuf},
};
impl Authority {
    fn reviewed_stage(&self, task: &Value) -> Result<Value, String> {
        let aid = task["agent_id"].as_str().ok_or("AgentRequired")?;
        let tid = task["task_id"].as_str().ok_or("TaskRequired")?;
        let grant = self.grant(aid, tid)?;
        let step = &task["current_step"];
        let stage =
            grant["document_stages"][step["step_id"].as_str().ok_or("StepRequired")?].clone();
        if stage.is_null()
            || stage["agent_id"] != aid
            || stage["task_id"] != tid
            || stage["resource"] != step["definition"]["resource"]
        {
            return Err("DocumentPreviewUnavailable".into());
        }
        let patch: Value = serde_json::from_str(
            step["action"]["body"]
                .as_str()
                .ok_or("ReviewedPatchRequired")?,
        )
        .map_err(|_| "InvalidDocumentPatch")?;
        if patch != stage["changes"]
            || patch != step["definition"]["changes"]
            || stage["version"] != step["definition"]["version"]
        {
            return Err("DocumentApprovalStale".into());
        }
        Ok(stage)
    }
    pub fn execute_document(&mut self, task: &Value) -> Result<Value, String> {
        let aid = task["agent_id"].as_str().ok_or("AgentRequired")?;
        let tid = task["task_id"].as_str().ok_or("TaskRequired")?;
        if task["state"] != "Executing"
            || task["permission"] != 1
            || self.grant(aid, tid)?["enabled"] != true
        {
            return Err("CurrentDocumentApprovalRequired".into());
        }
        let mut stage = self.reviewed_stage(task)?;
        let id = task["current_step"]["action"]["action_id"]
            .as_str()
            .ok_or("ActionRequired")?;
        if self.value["actions"].get(id).is_some() {
            return Err("ActionAlreadyStartedReconcileFirst".into());
        }
        let path = PathBuf::from(stage["path"].as_str().ok_or("DocumentPathRequired")?);
        let data = bytes(Path::new(
            stage["staged"].as_str().ok_or("StagedDocumentRequired")?,
        ))?;
        if digest(&data) != stage["staged_digest"] {
            return Err("DocumentPreviewChanged".into());
        }
        let backup = self.document_folder(tid).join(format!(
            "original-{}.{}",
            digest(id.as_bytes()),
            stage["format"].as_str().unwrap()
        ));
        let mut receipt = json!({"agent_id":aid,"task_id":tid,"action_id":id,"path":path,"resource":stage["resource"],"outcome":"Unknown","error":"DocumentWriteStarted","stage":stage,"backup":backup});
        let mut next = self.value.clone();
        next["actions"][id] = receipt.clone();
        self.save(next)?;
        let mut changed = false;
        let result = (|| -> Result<(), String> {
            let mut opts = fs::OpenOptions::new();
            opts.read(true).write(true).share_mode(0);
            if stage["mode"] == "create" {
                opts.create_new(true);
            } else {
                local(&path)?;
                if (stage["format"] == "docx" || stage["format"] == "xlsx")
                    && office_open_marker(&path)
                {
                    return Err("CloseSelectedOfficeDocumentBeforeUpdating".into());
                }
            }
            let mut target = opts.open(&path).map_err(|_| "DocumentLockedOrExists")?;
            if stage["mode"] != "create" {
                let file_identity = identity(&target)?;
                if file_identity != stage["file_identity"] || file_identity["links"] != 1 {
                    return Err("DocumentIdentityChangedOrSharedLink".into());
                }
                let mut old = Vec::new();
                Read::by_ref(&mut target)
                    .take(8 * 1024 * 1024 + 1)
                    .read_to_end(&mut old)
                    .map_err(|_| "DocumentReadFailed")?;
                if digest(&old) != stage["version"] {
                    return Err("DocumentVersionChanged".into());
                }
                let mut recovery = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&backup)
                    .map_err(|_| "RecoveryCopyUnavailable")?;
                recovery
                    .write_all(&old)
                    .and_then(|_| recovery.sync_all())
                    .map_err(|_| "RecoveryCopyUnavailable")?;
            }
            // Exclusive handle keeps the version check and write in one critical section.
            // A partial in-place update is Unknown and has an explicit recovery copy.
            changed = true;
            receipt["written_identity"] = identity(&target)?;
            stage["written_identity"] = receipt["written_identity"].clone();
            receipt["stage"] = stage.clone();
            target
                .seek(SeekFrom::Start(0))
                .and_then(|_| target.write_all(&data))
                .and_then(|_| target.set_len(data.len() as u64))
                .and_then(|_| target.sync_all())
                .map_err(|_| "DocumentWriteIncomplete")?;
            drop(target);
            self.verify_saved(&stage)?;
            Ok(())
        })();
        match result {
            Ok(()) => {
                receipt["outcome"] = json!("Success");
                receipt["error"] = Value::Null;
                receipt["bytes_written"] = json!(data.len());
                receipt["verification"] = json!("ReopenedAndVerified");
                receipt["changes"] = stage["changes"].clone();
                receipt["version"] = json!(digest(&data));
            }
            Err(error) => {
                receipt["outcome"] = json!(if changed { "Unknown" } else { "NotExecuted" });
                receipt["error"] = json!(error);
            }
        }
        let mut next = self.value.clone();
        next["actions"][id] = receipt.clone();
        self.save(next)?;
        receipt.as_object_mut().unwrap().remove("stage");
        Ok(receipt)
    }
    fn verify_saved(&self, stage: &Value) -> Result<(), String> {
        let path = Path::new(stage["path"].as_str().ok_or("DocumentPathRequired")?);
        let (actual, file_identity) = read_document(path)?;
        let expected = if stage["written_identity"].is_null() {
            &stage["file_identity"]
        } else {
            &stage["written_identity"]
        };
        if !expected.is_null() && *expected != file_identity {
            return Err("SavedDocumentIdentityChanged".into());
        }
        if digest(&actual) != stage["staged_digest"] {
            return Err("SavedDocumentChanged".into());
        }
        let fmt = stage["format"].as_str().unwrap();
        if fmt == "md" || fmt == "txt" {
            if String::from_utf8(actual).map_err(|_| "TextMustBeUtf8")?
                != stage["after"]["text"].as_str().unwrap_or("")
            {
                return Err("TextVerificationFailed".into());
            }
        } else {
            let snap = office::snapshot(
                &self.document_folder(stage["task_id"].as_str().unwrap()),
                path,
                fmt,
            )?;
            office::verify(
                &stage["before"],
                &snap,
                &stage["changes"],
                fmt,
                stage["mode"] == "create",
            )?;
        }
        Ok(())
    }
    pub fn resolve_document(&self, task: &Value) -> Result<Value, String> {
        let stage = self.reviewed_stage(task)?;
        let id = task["current_step"]["action"]["action_id"]
            .as_str()
            .ok_or("ActionRequired")?;
        let recorded = self.value["actions"].get(id);
        let mut receipt = recorded
            .cloned()
            .unwrap_or(json!({"outcome":"NotExecuted","error":"NoNativeWriteIntent"}));
        if recorded.is_some() && receipt["outcome"] != "NotExecuted" {
            match self.verify_saved(&stage) {
                Ok(()) => {
                    receipt["outcome"] = json!("Success");
                    receipt["error"] = Value::Null;
                    receipt["verification"] = json!("ReopenedAndVerified");
                }
                Err(e) => {
                    receipt["outcome"] = json!("Unknown");
                    receipt["error"] = json!(e);
                }
            }
            receipt["reconciled_by_user"] = json!(true);
        }
        receipt.as_object_mut().unwrap().remove("stage");
        Ok(receipt)
    }
    pub fn preview_document(&self, task: &Value, refid: &str) -> Result<Value, String> {
        let aid = task["agent_id"].as_str().ok_or("AgentRequired")?;
        let tid = task["task_id"].as_str().ok_or("TaskRequired")?;
        let grant = self.grant(aid, tid)?;
        let i = refid
            .strip_prefix("document")
            .and_then(|s| s.parse::<usize>().ok())
            .and_then(|n| n.checked_sub(1))
            .ok_or("InvalidDocumentResource")?;
        let r = &grant["command"]["payload"]["documents"][i];
        let path = Path::new(r["path"].as_str().ok_or("DocumentOutsideScope")?);
        let fmt = r["format"].as_str().unwrap();
        if !task["runs"][0]["steps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| {
                s["definition"]["resource"] == refid
                    && s["action"]["receipt"]["outcome"] == "Success"
            })
        {
            return Err("DocumentHasNoConfirmedSave".into());
        }
        let snapshot = if fmt == "md" || fmt == "txt" {
            json!({"text":String::from_utf8(bytes(path)?).map_err(|_|"TextMustBeUtf8")?})
        } else {
            office::snapshot(&self.document_folder(tid), path, fmt)?
        };
        Ok(
            json!({"path":path,"available":true,"content":serde_json::to_string_pretty(&snapshot).unwrap()}),
        )
    }
    pub fn open_saved_document(&self, task: &Value, refid: &str) -> Result<Value, String> {
        let tid = task["task_id"].as_str().ok_or("TaskRequired")?;
        let aid = task["agent_id"].as_str().ok_or("AgentRequired")?;
        self.grant(aid, tid)?;
        let step = task["runs"][0]["steps"]
            .as_array()
            .ok_or("TaskStepsRequired")?
            .iter()
            .find(|s| {
                s["definition"]["resource"] == refid
                    && s["action"]["receipt"]["outcome"] == "Success"
            })
            .ok_or("DocumentHasNoConfirmedSave")?;
        let recorded = &self.value["actions"][step["action"]["action_id"]
            .as_str()
            .ok_or("ActionRequired")?];
        let stage = &recorded["stage"];
        if stage["agent_id"] != aid
            || stage["task_id"] != tid
            || stage["resource"] != refid
            || recorded["outcome"] == "NotExecuted"
        {
            return Err("NativeDocumentReceiptUnavailable".into());
        }
        self.verify_saved(stage)?;
        let path = stage["path"].as_str().ok_or("DocumentPathRequired")?;
        std::process::Command::new("explorer.exe")
            .arg(path)
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|_| "DocumentOpenFailed")?;
        Ok(json!({"path":path,"handed_to_user":true}))
    }
    fn document_folder(&self, tid: &str) -> PathBuf {
        self.path_parent()
            .join("document-work")
            .join(digest(tid.as_bytes()))
    }
    fn path_parent(&self) -> &Path {
        self.path.parent().unwrap()
    }
    fn document_resource(&self, task: &Value, provider: &Value) -> Result<(String, Value), String> {
        let grant = self.agent_scope(task, provider)?;
        let refid = task["current_step"]["definition"]["resource"]
            .as_str()
            .ok_or("DocumentResourceRequired")?;
        let i = refid
            .strip_prefix("document")
            .and_then(|s| s.parse::<usize>().ok())
            .and_then(|n| n.checked_sub(1))
            .ok_or("InvalidDocumentResource")?;
        let d = grant["command"]["payload"]["documents"]
            .get(i)
            .filter(|v| v.is_object())
            .ok_or("DocumentOutsideScope")?;
        Ok((refid.into(), d.clone()))
    }
    pub fn document_step(&mut self, task: &Value, provider: &Value) -> Result<Value, String> {
        let (refid, resource) = self.document_resource(task, provider)?;
        let aid = task["agent_id"].as_str().ok_or("AgentRequired")?;
        let tid = task["task_id"].as_str().ok_or("TaskRequired")?;
        let d = &task["current_step"]["definition"];
        let op = d["op"].as_str().ok_or("DocumentOperationRequired")?;
        let path = Path::new(resource["path"].as_str().ok_or("DocumentPathRequired")?);
        let fmt = resource["format"].as_str().unwrap();
        let scope = resource["scope"].as_str().unwrap();
        let folder = self.document_folder(tid);
        fs::create_dir_all(&folder).map_err(|_| "DocumentWorkUnavailable")?;
        let create = resource["mode"] == "create" && !path.exists();
        if resource["mode"] == "create" && path.exists() {
            let confirmed = task["runs"][0]["steps"]
                .as_array()
                .and_then(|a| {
                    a.iter().find(|s| {
                        s["definition"]["resource"] == refid
                            && s["action"]["receipt"]["outcome"] == "Success"
                    })
                })
                .ok_or("NewDocumentAlreadyExists")?;
            let record = &self.value["actions"][confirmed["action"]["action_id"]
                .as_str()
                .ok_or("NativeDocumentReceiptRequired")?];
            if record["stage"]["task_id"] != tid || record["stage"]["resource"] != refid {
                return Err("NativeDocumentReceiptRequired".into());
            }
            self.verify_saved(&record["stage"])?;
        }
        let (data, file_identity) = if create {
            (Vec::new(), Value::Null)
        } else {
            read_document(path)?
        };
        let version = if create { "new".into() } else { digest(&data) };
        let copy = folder.join(format!("read-{}.{}", uuid::Uuid::new_v4(), fmt));
        if !create {
            fs::write(&copy, &data).map_err(|_| "DocumentSnapshotUnavailable")?;
        }
        let snapshot = if create {
            json!({"kind":if fmt=="docx" {"word"} else {"excel"},"entries":[],"sheets":[]})
        } else if fmt == "md" || fmt == "txt" {
            json!({"text":String::from_utf8(data.clone()).map_err(|_|"TextMustBeUtf8")?})
        } else {
            office::snapshot(&folder, &copy, fmt)?
        };
        let mut observation = json!({"resource":refid,"status":"Success","version":version});
        match op {
            "office_inspect" => {
                if fmt == "docx" {
                    observation["structure"] = json!({"paragraphs":snapshot["entries"].as_array().unwrap().iter().filter(|e|e["target"].as_str().unwrap_or("").starts_with('p')).count(),"tables":snapshot["tables"].as_array().map(|a|a.iter().map(|v|json!({"id":v["id"],"rows":v["rows"],"columns":v["columns"],"editable":v["editable"]!=false})).collect::<Vec<_>>()),"targets":snapshot["entries"].as_array().unwrap().iter().filter(|e|scope=="*"||scope.split(',').any(|id|e["target"]==id)).take(40).map(|e|json!({"target":e["target"],"style":e["style"],"editable":e["safe"]})).collect::<Vec<_>>()});
                } else if fmt == "xlsx" {
                    observation["structure"] = json!({"sheets":snapshot["sheets"].as_array().unwrap().iter().filter(|s|scope=="*"||scope.rsplit_once('!').map(|(name,_)|s["name"]==name).unwrap_or(false)).cloned().collect::<Vec<_>>(),"date1904":snapshot["date1904"],"scope":scope});
                } else {
                    observation["structure"] = json!({"total_characters":snapshot["text"].as_str().unwrap().chars().count()});
                }
            }
            "office_read" => {
                if create {
                    return Err("ReadBeforeCreate".into());
                }
                let target = d["target"].as_str().ok_or("DocumentReadTargetRequired")?;
                let start = d["start"].as_u64().ok_or("ReadStartRequired")? as usize;
                let len = d["length"].as_u64().ok_or("ReadLengthRequired")? as usize;
                if len == 0 {
                    return Err("ReadLengthRequired".into());
                }
                if fmt == "md" || fmt == "txt" {
                    if len > 2048 || target != "body" {
                        return Err("InvalidTextRange".into());
                    }
                    let text = snapshot["text"].as_str().unwrap();
                    if start > text.chars().count() {
                        return Err("ReadStartBeyondEnd".into());
                    }
                    observation["content"] =
                        json!(text.chars().skip(start).take(len).collect::<String>());
                    observation["start"] = json!(start);
                    observation["total_characters"] = json!(text.chars().count());
                } else {
                    let all = snapshot["entries"]
                        .as_array()
                        .ok_or("OfficeSnapshotUnavailable")?;
                    let selected: Vec<Value> = if fmt == "docx" {
                        if len > 20 {
                            return Err("WordReadCapacityExceeded".into());
                        }
                        if target != "body" && !valid_word_id(target) {
                            return Err("InvalidWordTarget".into());
                        }
                        let eligible: Vec<_> = all
                            .iter()
                            .filter(|e| {
                                (target == "body"
                                    && e["target"].as_str().unwrap_or("").starts_with('p')
                                    || e["target"] == target)
                                    && (scope == "*"
                                        || scope.split(',').any(|id| e["target"] == id))
                            })
                            .collect();
                        if eligible.is_empty() || start >= eligible.len() {
                            return Err("WordTargetOutsideScopeOrMissing".into());
                        }
                        eligible
                            .into_iter()
                            .skip(start)
                            .take(len)
                            .cloned()
                            .collect()
                    } else {
                        if len > 200 || start != 0 {
                            return Err("ExcelReadCapacityExceeded".into());
                        }
                        let (sheet, r) = target.rsplit_once('!').ok_or("UseSheetAndRange")?;
                        inside(scope, sheet, r)?;
                        let b = range_bounds(r)?;
                        if (b.2 - b.0 + 1) * (b.3 - b.1 + 1) > len as u32 {
                            return Err("ExcelReadRangeExceedsLength".into());
                        }
                        office::invoke(&folder,&json!({"op":"read_range","kind":"excel","path":copy,"sheet":sheet,"range":r,"scope":scope}))?["entries"].as_array().ok_or("OfficeReadUnavailable")?.clone()
                    };
                    if serde_json::to_vec(&selected).unwrap().len() > 24000 {
                        return Err("DocumentReadCharacterCapacityExceeded".into());
                    }
                    let total = if fmt == "docx" {
                        all.iter()
                            .filter(|e| {
                                (target == "body"
                                    && e["target"].as_str().unwrap_or("").starts_with('p')
                                    || e["target"] == target)
                                    && (scope == "*"
                                        || scope.split(',').any(|id| e["target"] == id))
                            })
                            .count()
                    } else {
                        selected.len()
                    };
                    observation["range_complete"] = json!(start + selected.len() >= total);
                    observation["total_units"] = json!(total);
                    observation["entries"] = json!(selected);
                    observation["start"] = json!(start);
                    observation["target"] = json!(target);
                    if fmt == "xlsx" {
                        observation["calculation_state"] = json!("StoredValuesNotRecalculated");
                    }
                }
            }
            "office_calculate" => {
                if fmt != "xlsx" || create {
                    return Err("CalculationRequiresExistingWorkbook".into());
                }
                let answer = office::invoke(
                    &folder,
                    &json!({"op":"calculate","kind":"excel","path":copy,"sheet":d["sheet"],"formula":d["formula"],"scope":scope}),
                )?;
                observation["calculation"] = answer["calculation"].clone();
            }
            "office_propose" | "text_propose" => {
                if resource["mode"] == "read" || d["version"] != version {
                    return Err("DocumentVersionChangedOrReadOnly".into());
                }
                let changes = d["changes"]
                    .as_array()
                    .filter(|a| !a.is_empty() && a.len() <= 20)
                    .ok_or("InvalidDocumentPatch")?;
                let observed = self.value["grants"][tid]["document_reads"][&refid].clone();
                if !create && observed["version"] != version {
                    return Err("ProposalRequiresActualObservation".into());
                }
                if !create && observed["file_identity"] != file_identity {
                    return Err("DocumentIdentityChanged".into());
                }
                let staged = folder.join(format!(
                    "stage-{}.{}",
                    digest(
                        task["current_step"]["step_id"]
                            .as_str()
                            .ok_or("StepRequired")?
                            .as_bytes()
                    ),
                    fmt
                ));
                let after;
                if fmt == "md" || fmt == "txt" {
                    if op != "text_propose" || create {
                        return Err("UseTextUpdateAction".into());
                    }
                    let original = snapshot["text"].as_str().unwrap();
                    let mut edits = Vec::new();
                    let mut ranges: Vec<(usize, usize)> = observed["ranges"]
                        .as_array()
                        .ok_or("ActualTextRangesRequired")?
                        .iter()
                        .filter_map(|v| Some((v[0].as_u64()? as usize, v[1].as_u64()? as usize)))
                        .collect();
                    ranges.sort_unstable();
                    let mut merged: Vec<(usize, usize)> = Vec::new();
                    for (start, end) in ranges {
                        if let Some(last) = merged.last_mut().filter(|r| start <= r.1) {
                            last.1 = last.1.max(end);
                        } else {
                            merged.push((start, end));
                        }
                    }
                    for c in changes {
                        let old = c["old"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .ok_or("ExactTextRequired")?;
                        let new = c["text"]
                            .as_str()
                            .filter(|s| s.len() <= 32768)
                            .ok_or("ReplacementTextRequired")?;
                        if original.matches(old).count() != 1 {
                            return Err("AmbiguousTextTarget".into());
                        }
                        let offset = original.find(old).unwrap();
                        let start = original[..offset].chars().count();
                        let end = start + old.chars().count();
                        if !merged.iter().any(|r| r.0 <= start && r.1 >= end) {
                            return Err("UnreadTextTarget".into());
                        }
                        if edits.iter().any(|(a, b, _): &(usize, usize, &str)| {
                            offset < *b && offset + old.len() > *a
                        }) {
                            return Err("OverlappingTextTargets".into());
                        }
                        edits.push((offset, offset + old.len(), new));
                    }
                    let mut text = original.to_string();
                    edits.sort_by_key(|v| std::cmp::Reverse(v.0));
                    for (start, end, new) in edits {
                        text.replace_range(start..end, new);
                    }
                    fs::write(&staged, text.as_bytes()).map_err(|_| "DocumentStageFailed")?;
                    after = json!({"text":text});
                } else {
                    if op != "office_propose" {
                        return Err("UseOfficeProposal".into());
                    }
                    validate_patch(changes, &observed, &resource, create)?;
                    let answer = office::invoke(
                        &folder,
                        &json!({"op":if create {"create"} else {"patch"},"kind":if fmt=="docx" {"word"} else {"excel"},"path":copy,"output":staged,"scope":scope,"changes":changes}),
                    )?;
                    after = answer["snapshot"].clone();
                    office::verify(&snapshot, &after, &d["changes"], fmt, create)?;
                }
                let staged_bytes = bytes(&staged)?;
                let record = json!({"agent_id":aid,"task_id":tid,"resource":refid,"path":path,"mode":resource["mode"],"format":fmt,"version":version,"file_identity":file_identity,"changes":d["changes"],"staged":staged,"staged_digest":digest(&staged_bytes),"before":snapshot,"after":after});
                let mut next = self.value.clone();
                next["grants"][tid]["document_stages"]
                    [task["current_step"]["step_id"].as_str().unwrap()] = record;
                self.save(next)?;
                observation["diff"] = json!(changes);
                observation["preview"] = if fmt == "md" || fmt == "txt" {
                    json!({"text":changes.iter().map(|c|c["text"].as_str().unwrap_or("")).collect::<Vec<_>>().join("\n"),"total_characters":after["text"].as_str().unwrap().chars().count()})
                } else {
                    preview(&after, &d["changes"], fmt)
                };
                observation["mode"] = resource["mode"].clone();
            }
            _ => return Err("UnsupportedDocumentOperation".into()),
        }
        if op == "office_inspect" || op == "office_read" {
            let mut next = self.value.clone();
            if next["grants"][tid]["document_reads"].is_null() {
                next["grants"][tid]["document_reads"] = json!({});
            }
            let mut prior = next["grants"][tid]["document_reads"][&refid].clone();
            if prior["version"] != version {
                prior = json!({"version":version,"entries":[],"ranges":[]});
            }
            prior["file_identity"] = file_identity;
            if op == "office_read" {
                if let Some(entries) = observation["entries"].as_array() {
                    let target = prior["entries"]
                        .as_array_mut()
                        .ok_or("InvalidDocumentObservation")?;
                    for e in entries {
                        if !target.contains(e) {
                            target.push(e.clone());
                        }
                    }
                }
                if let Some(text) = observation["content"].as_str() {
                    let start = observation["start"].as_u64().unwrap_or(0);
                    prior["ranges"]
                        .as_array_mut()
                        .ok_or("InvalidTextObservation")?
                        .push(json!([start, start + text.chars().count() as u64]));
                }
            }
            next["grants"][tid]["document_reads"][&refid] = prior;
            self.save(next)?;
        }
        Ok(observation)
    }
}

fn preview(snapshot: &Value, changes: &Value, fmt: &str) -> Value {
    let entries = snapshot["entries"].as_array().cloned().unwrap_or_default();
    json!({"entries":entries.into_iter().filter(|e| changes.as_array().unwrap().iter().any(|c|if fmt=="docx" {c["target"]==e["target"]||!c["type"].is_null()} else {c["sheet"]==e["sheet"]&&c["cell"]==e["cell"]})).collect::<Vec<_>>()})
}
fn validate_patch(
    changes: &[Value],
    observed: &Value,
    r: &Value,
    create: bool,
) -> Result<(), String> {
    let fmt = r["format"].as_str().unwrap();
    let scope = r["scope"].as_str().unwrap();
    let mut used = std::collections::HashSet::new();
    for c in changes {
        if fmt == "docx" {
            if create {
                if !["paragraph", "heading", "table"].contains(&c["type"].as_str().unwrap_or("")) {
                    return Err("UnsupportedWordCreate".into());
                }
                if c["type"] == "table" {
                    let rows = c["rows"]
                        .as_array()
                        .filter(|a| !a.is_empty() && a.len() <= 20)
                        .ok_or("InvalidWordTable")?;
                    let count = rows[0]
                        .as_array()
                        .filter(|a| !a.is_empty() && a.len() <= 10)
                        .ok_or("InvalidWordTable")?
                        .len();
                    if rows.iter().any(|r| {
                        r.as_array()
                            .map(|a| {
                                a.len() != count
                                    || a.iter().any(|v| {
                                        v.as_str()
                                            .map(|s| {
                                                s.len() > 4000 || s.contains(['\r', '\n', '\u{7}'])
                                            })
                                            .unwrap_or(true)
                                    })
                            })
                            .unwrap_or(true)
                    }) {
                        return Err("InvalidWordTable".into());
                    }
                }
            } else {
                let id = c["target"].as_str().ok_or("WordTargetRequired")?;
                if !valid_word_id(id)
                    || (scope != "*" && !scope.split(',').any(|s| s == id))
                    || !used.insert(id.to_string())
                {
                    return Err("InvalidOrDuplicateWordTarget".into());
                }
                let entry = observed["entries"]
                    .as_array()
                    .and_then(|a| a.iter().find(|e| e["target"] == id))
                    .ok_or("UnreadWordTarget")?;
                if entry["text"] != c["old"] || entry["safe"] != true {
                    return Err("WordTargetChangedOrUnsupported".into());
                }
            }
            if c["type"] != "table" {
                let text = c["text"]
                    .as_str()
                    .filter(|s| s.len() <= 24000 && !s.contains(['\r', '\n', '\u{7}']))
                    .ok_or("InvalidWordText")?;
                let _ = text;
            }
        } else {
            let sheet = c["sheet"].as_str().ok_or("SheetRequired")?;
            let address = c["cell"].as_str().ok_or("CellRequired")?;
            let _ = cell(address)?;
            inside(scope, sheet, address)?;
            if !used.insert(format!("{sheet}!{address}")) {
                return Err("DuplicateExcelTarget".into());
            }
            if !create {
                let old = observed["entries"]
                    .as_array()
                    .and_then(|a| {
                        a.iter()
                            .find(|e| e["sheet"] == sheet && e["cell"] == address)
                    })
                    .ok_or("UnreadExcelTarget")?;
                let mut expected = c["old"].clone();
                if expected["value"].as_f64().is_some()
                    && expected["value"].as_f64() == old["value"].as_f64()
                {
                    expected["value"] = old["value"].clone();
                }
                if *old != expected {
                    return Err("ExcelOldCellMismatch".into());
                }
            }
            if !["text", "number", "boolean", "date", "formula", "empty"]
                .contains(&c["kind"].as_str().unwrap_or(""))
            {
                return Err("UnsupportedCellType".into());
            }
        }
    }
    Ok(())
}
