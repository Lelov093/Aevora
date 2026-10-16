//! Fixed, bounded native Office bridge; no model-visible shell or COM dispatch.
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Write},
    os::windows::process::CommandExt,
    path::Path,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub fn invoke(folder: &Path, request: &Value) -> Result<Value, String> {
    fs::create_dir_all(folder).map_err(|_| "OfficeWorkDirectoryUnavailable")?;
    let script = folder.join("office-worker.ps1");
    let code = include_str!("office-worker.ps1");
    if fs::read_to_string(&script).ok().as_deref() != Some(code) {
        fs::write(&script, code).map_err(|_| "OfficeAdapterUnavailable")?;
    }
    let owner = folder.join(format!("instance-{}.json", uuid::Uuid::new_v4()));
    let mut input = request.clone();
    input["owner_file"] = json!(owner);
    let mut child = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-STA", "-File"])
        .arg(&script)
        .creation_flags(0x08000000)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "OfficeAdapterUnavailable")?;
    let mut stdin = child.stdin.take().ok_or("OfficeAdapterInputUnavailable")?;
    stdin
        .write_all(serde_json::to_string(&input).unwrap().as_bytes())
        .map_err(|_| "OfficeAdapterInputFailed")?;
    drop(stdin);
    let mut stdout = child
        .stdout
        .take()
        .ok_or("OfficeAdapterOutputUnavailable")?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or("OfficeAdapterOutputUnavailable")?;
    let out = thread::spawn(move || {
        let mut bytes = Vec::new();
        stdout
            .by_ref()
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let err = thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr
            .by_ref()
            .take(8192)
            .read_to_end(&mut bytes)
            .map(|_| bytes)
    });
    let start = Instant::now();
    loop {
        if child
            .try_wait()
            .map_err(|_| "OfficeAdapterWaitFailed")?
            .is_some()
        {
            break;
        }
        if start.elapsed() > Duration::from_secs(90) {
            let _ = child.kill();
            let _ = child.wait();
            // Only the HWND-proven instance created by this invocation is ours.
            if let Ok(bytes) = fs::read(&owner) {
                if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                    if let Some(pid) = v["pid"].as_u64() {
                        unsafe {
                            use windows_sys::Win32::System::Threading::{
                                GetProcessTimes, OpenProcess, TerminateProcess,
                                PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
                            };
                            let handle = OpenProcess(
                                PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                                0,
                                pid as u32,
                            );
                            if !handle.is_null() {
                                let mut creation = std::mem::zeroed();
                                let mut exit = std::mem::zeroed();
                                let mut kernel = std::mem::zeroed();
                                let mut user = std::mem::zeroed();
                                if GetProcessTimes(
                                    handle,
                                    &mut creation,
                                    &mut exit,
                                    &mut kernel,
                                    &mut user,
                                ) != 0
                                {
                                    let ft = ((creation.dwHighDateTime as u64) << 32)
                                        | creation.dwLowDateTime as u64;
                                    if v["creation_filetime"].as_u64() == Some(ft) {
                                        TerminateProcess(handle, 1);
                                    }
                                }
                                windows_sys::Win32::Foundation::CloseHandle(handle);
                            }
                        }
                    }
                }
            }
            return Err("OfficeTimeoutOwnedInstanceStopped".into());
        }
        thread::sleep(Duration::from_millis(50));
    }
    let bytes = out
        .join()
        .map_err(|_| "OfficeAdapterOutputFailed")?
        .map_err(|_| "OfficeAdapterOutputFailed")?;
    let _ = err.join();
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("OfficeCapacityExceeded".into());
    }
    let result: Value = serde_json::from_slice(&bytes).map_err(|_| "OfficeAdapterInvalidResult")?;
    if result["status"] != "Success" {
        return Err(result["error"].as_str().unwrap_or("OfficeBlocked").into());
    }
    Ok(result)
}

pub fn snapshot(folder: &Path, path: &Path, format: &str) -> Result<Value, String> {
    Ok(invoke(
        folder,
        &json!({"op":"snapshot","kind":if format=="docx" {"word"} else {"excel"},"path":path}),
    )?["snapshot"]
        .clone())
}

pub fn verify(
    before: &Value,
    after: &Value,
    changes: &Value,
    format: &str,
    create: bool,
) -> Result<(), String> {
    let ops = changes.as_array().ok_or("InvalidDocumentPatch")?;
    let entries = after["entries"]
        .as_array()
        .ok_or("OfficeSnapshotUnavailable")?;
    if format == "docx" {
        if !create {
            for key in [
                "tables",
                "pictures",
                "headers",
                "protection",
                "revisions",
                "fields",
                "shapes",
                "track_revisions",
            ] {
                if before[key] != after[key] {
                    return Err(format!("WordPreservationFailed:{key}"));
                }
            }
            let prior = before["entries"]
                .as_array()
                .ok_or("OfficeSnapshotUnavailable")?;
            if prior.len() != entries.len() {
                return Err("WordStructureChanged".into());
            }
            for old in prior {
                let new = entries
                    .iter()
                    .find(|v| v["target"] == old["target"])
                    .ok_or("WordTargetMissing")?;
                let mut expected = old.clone();
                if let Some(op) = ops.iter().find(|c| c["target"] == old["target"]) {
                    expected["text"] = op["text"].clone();
                }
                if expected != *new {
                    return Err("WordContentOrStyleVerificationFailed".into());
                }
            }
        } else {
            let text: Vec<_> = entries
                .iter()
                .filter(|v| v["target"].as_str().unwrap_or("").starts_with('p'))
                .filter_map(|v| v["text"].as_str())
                .filter(|s| !s.is_empty())
                .collect();
            for op in ops {
                if op["type"] == "table" {
                    let rows = op["rows"].as_array().ok_or("InvalidWordTable")?;
                    for row in rows {
                        for cell in row.as_array().ok_or("InvalidWordTable")? {
                            if !entries.iter().any(|v| v["text"] == *cell) {
                                return Err("NewWordTableVerificationFailed".into());
                            }
                        }
                    }
                } else if !text.contains(&op["text"].as_str().ok_or("InvalidWordText")?) {
                    return Err("NewWordTextVerificationFailed".into());
                }
            }
        }
    } else {
        if !create {
            // UsedRange can expand for an approved new cell; sheet identities and protection cannot.
            let a = before["sheets"]
                .as_array()
                .ok_or("OfficeSnapshotUnavailable")?;
            let b = after["sheets"]
                .as_array()
                .ok_or("OfficeSnapshotUnavailable")?;
            if a.len() != b.len()
                || a.iter()
                    .zip(b)
                    .any(|(x, y)| x["name"] != y["name"] || x["protected"] != y["protected"])
                || before["date1904"] != after["date1904"]
            {
                return Err("ExcelStructureChanged".into());
            }
            for old in before["entries"]
                .as_array()
                .ok_or("OfficeSnapshotUnavailable")?
            {
                if ops
                    .iter()
                    .any(|c| c["sheet"] == old["sheet"] && c["cell"] == old["cell"])
                {
                    continue;
                }
                let new = entries
                    .iter()
                    .find(|v| v["sheet"] == old["sheet"] && v["cell"] == old["cell"])
                    .ok_or("ExcelCellMissing")?;
                let mut expected = old.clone();
                if old["kind"] == "formula" {
                    expected["value"] = new["value"].clone();
                }
                if expected != *new {
                    return Err("ExcelUnselectedCellChanged".into());
                }
            }
        }
        for op in ops {
            let cell = entries
                .iter()
                .find(|v| v["sheet"] == op["sheet"] && v["cell"] == op["cell"])
                .ok_or("ExcelTargetMissing")?;
            let key = if op["kind"] == "formula" {
                "formula"
            } else {
                "value"
            };
            if cell["kind"] != op["kind"]
                || (cell[key] != op["value"]
                    && !(op["kind"] == "number" && cell[key].as_f64() == op["value"].as_f64()))
            {
                return Err("ExcelValueVerificationFailed".into());
            }
            if !op["number_format"].is_null() && cell["number_format"] != op["number_format"] {
                return Err("ExcelFormatVerificationFailed".into());
            }
        }
    }
    Ok(())
}
