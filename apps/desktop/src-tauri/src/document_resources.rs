//! Selected local document paths, versions, file identity and bounded ranges.
use crate::{office, tools::local};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    path::Path,
};
pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub(crate) fn bytes(path: &Path) -> Result<Vec<u8>, String> {
    read_document(path).map(|(b, _)| b)
}
pub(crate) fn identity(file: &fs::File) -> Result<Value, String> {
    unsafe {
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
        if GetFileInformationByHandle(file.as_raw_handle(), &mut info) == 0 {
            return Err("DocumentIdentityUnavailable".into());
        }
        Ok(
            json!({"volume":info.dwVolumeSerialNumber,"index":((info.nFileIndexHigh as u64)<<32)|info.nFileIndexLow as u64,"links":info.nNumberOfLinks}),
        )
    }
}
pub(crate) fn office_open_marker(path: &Path) -> bool {
    let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let parent = path.parent().unwrap_or(Path::new(""));
    parent.join(format!("~${name}")).exists()
        || parent
            .join(format!("~${}", name.chars().skip(2).collect::<String>()))
            .exists()
}
pub(crate) fn read_document(path: &Path) -> Result<(Vec<u8>, Value), String> {
    local(path)?;
    let mut f = fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(path)
        .map_err(|_| "DocumentLockedOrUnavailable")?;
    if f.metadata().map_err(|_| "DocumentUnavailable")?.len() > 8 * 1024 * 1024 {
        return Err("OfficeCapacityExceeded".into());
    }
    let mut b = Vec::new();
    Read::by_ref(&mut f)
        .take(8 * 1024 * 1024 + 1)
        .read_to_end(&mut b)
        .map_err(|_| "DocumentReadFailed")?;
    if b.len() > 8 * 1024 * 1024 {
        return Err("OfficeCapacityExceeded".into());
    }
    Ok((b, identity(&f)?))
}
pub(crate) fn format(path: &str) -> Result<String, String> {
    let f = Path::new(path)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !["docx", "xlsx", "md", "txt"].contains(&f.as_str()) {
        return Err("UnsupportedDocumentFormat".into());
    }
    Ok(f)
}
pub fn validate_resources(
    c: &mut Value,
    used: &mut std::collections::HashSet<String>,
) -> Result<(), String> {
    let documents = c["payload"]
        .get("documents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if documents.len() > 4 {
        return Err("SelectAtMostFourDocuments".into());
    }
    let mut writable = 0;
    for d in &documents {
        let p = d["path"].as_str().ok_or("DocumentPathRequired")?;
        let fmt = format(p)?;
        if d["format"] != fmt
            || !["read", "update", "create"].contains(&d["mode"].as_str().unwrap_or(""))
            || d["label"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .is_none()
        {
            return Err("InvalidDocumentResource".into());
        }
        if d["mode"] == "create" {
            if !Path::new(p).is_absolute()
                || p.starts_with("\\\\")
                || p.get(2..).unwrap_or("").contains(':')
                || Path::new(p)
                    .components()
                    .any(|v| matches!(v, std::path::Component::ParentDir))
            {
                return Err("ChooseAnAbsoluteLocalDocumentPath".into());
            }
            if fmt == "md" || fmt == "txt" {
                return Err("UseTextOutputForNewTextFiles".into());
            }
            local(Path::new(p).parent().ok_or("DocumentParentRequired")?)?;
            if Path::new(p).exists() {
                return Err("NewDocumentAlreadyExists".into());
            }
        } else {
            let content = bytes(Path::new(p))?;
            if (fmt=="md"||fmt=="txt")&&content.len()>1024*1024{return Err("TextCapacityExceeded".into());}
            if d["mode"] == "update"
                && (fmt == "docx" || fmt == "xlsx")
                && office_open_marker(Path::new(p))
            {
                return Err("CloseSelectedOfficeDocumentBeforeUpdating".into());
            }
        }
        if d["mode"] != "read" {
            writable += 1;
        }
        let scope = d["scope"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 200)
            .ok_or("DocumentScopeRequired")?;
        if scope != "*" {
            if fmt == "docx" {
                if scope.split(',').any(|id| !valid_word_id(id)) {
                    return Err("UseExactWordTargetIds".into());
                }
            } else if fmt == "xlsx" {
                let (sheet, range) = scope.rsplit_once('!').ok_or("UseSheetAndCellRange")?;
                if sheet.is_empty() {
                    return Err("WorksheetRequired".into());
                }
                let _ = range_bounds(range)?;
            } else {
                return Err("UseWholeTextWithExactPatches".into());
            }
        }
        if !used.insert(p.to_lowercase().replace('/', "\\")) {
            return Err("DuplicateDocumentTarget".into());
        }
    }
    if writable + c["payload"]["outputs"].as_array().map_or(0, Vec::len) > 2 {
        return Err("SelectAtMostTwoWriteTargets".into());
    }
    Ok(())
}
pub(crate) fn valid_word_id(s: &str) -> bool {
    if let Some(n) = s.strip_prefix('p') {
        return n.parse::<u32>().map(|v| v > 0).unwrap_or(false);
    }
    if let Some(t) = s.strip_prefix('t') {
        if let Some((n, rc)) = t.split_once('r') {
            if let Some((r, c)) = rc.split_once('c') {
                return [n, r, c]
                    .iter()
                    .all(|n| n.parse::<u32>().map(|v| v > 0).unwrap_or(false));
            }
        }
    }
    false
}
pub(crate) fn cell(s: &str) -> Result<(u32, u32), String> {
    let s = s.replace('$', "");
    let n = s
        .find(|c: char| c.is_ascii_digit())
        .ok_or("InvalidCellAddress")?;
    let (col, row) = s.split_at(n);
    let mut x = 0u32;
    if col.is_empty() || col.len() > 3 || !col.chars().all(|c| c.is_ascii_uppercase()) {
        return Err("InvalidCellAddress".into());
    }
    for c in col.bytes() {
        x = x * 26 + (c - b'A' + 1) as u32;
    }
    let y = row.parse::<u32>().map_err(|_| "InvalidCellAddress")?;
    if x > 16384 || y == 0 || y > 1048576 {
        return Err("InvalidCellAddress".into());
    }
    Ok((x, y))
}
pub(crate) fn range_bounds(s: &str) -> Result<(u32, u32, u32, u32), String> {
    let (a, b) = s.split_once(':').unwrap_or((s, s));
    let (x, y) = cell(a)?;
    let (w, z) = cell(b)?;
    if w < x || z < y {
        return Err("InvalidCellRange".into());
    }
    Ok((x, y, w, z))
}
pub(crate) fn inside(scope: &str, sheet: &str, address: &str) -> Result<(), String> {
    let a = range_bounds(address)?;
    if (a.2 - a.0 + 1) as u64 * (a.3 - a.1 + 1) as u64 > 10000 {
        return Err("OfficeCapacityExceeded".into());
    }
    if scope == "*" {
        return Ok(());
    }
    let (name, r) = scope.rsplit_once('!').ok_or("InvalidExcelScope")?;
    let b = range_bounds(r)?;
    if name != sheet || a.0 < b.0 || a.1 < b.1 || a.2 > b.2 || a.3 > b.3 {
        return Err("RangeOutsideScope".into());
    }
    Ok(())
}
pub fn inspect_selection(data: &Path, resource: &Value) -> Result<Value, String> {
    let path = Path::new(resource["path"].as_str().ok_or("DocumentPathRequired")?);
    let fmt = format(path.to_str().ok_or("UnicodePathRequired")?)?;
    let content = bytes(path)?;
    let folder = data
        .join("document-preview")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&folder).map_err(|_| "DocumentWorkUnavailable")?;
    let copy = folder.join(format!("selected.{fmt}"));
    fs::write(&copy, &content).map_err(|_| "DocumentSnapshotUnavailable")?;
    if fmt == "md" || fmt == "txt" {
        return Ok(
            json!({"format":fmt,"characters":String::from_utf8(content).map_err(|_|"TextMustBeUtf8")?.chars().count()}),
        );
    }
    let snapshot = office::snapshot(&folder, &copy, &fmt)?;
    let targets:Vec<Value>=snapshot["entries"].as_array().unwrap().iter().take(200).map(|v|json!({"id":v["target"],"text":v["text"].as_str().unwrap_or("").chars().take(100).collect::<String>(),"editable":v["safe"]})).collect();
    Ok(
        json!({"format":fmt,"targets":targets,"sheets":snapshot["sheets"],"limited":snapshot["entries"].as_array().unwrap().len()>200}),
    )
}
