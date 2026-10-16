//! Reviewed local programs with bounded output, Job Object lifetime and cancellation.
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};
fn running() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}
pub fn reserve(task: &str) -> Result<(), String> {
    let mut registry = running().lock().unwrap();
    if registry.contains_key(task) {
        return Err("CommandAlreadyRunning".into());
    }
    registry.insert(task.into(), Arc::new(AtomicBool::new(false)));
    Ok(())
}
pub fn cancel(task: &str) {
    if let Some(flag) = running().lock().unwrap().get(task) {
        flag.store(true, Ordering::SeqCst);
    }
}
pub fn cancel_all() {
    for flag in running().lock().unwrap().values() {
        flag.store(true, Ordering::SeqCst);
    }
}
pub fn program(id: &str, project: &Path) -> Result<PathBuf, String> {
    let path = match id {
        "python" => project.join(".venv/Scripts/python.exe"),
        "powershell" => {
            PathBuf::from(std::env::var_os("SystemRoot").ok_or("WindowsDirectoryUnavailable")?)
                .join("System32/WindowsPowerShell/v1.0/powershell.exe")
        }
        _ => return Err("ProgramNotRegistered".into()),
    };
    crate::tools::local(&path)?;
    if !path.is_file() {
        return Err("RegisteredProgramUnavailable".into());
    }
    Ok(path)
}
fn capture(
    mut pipe: impl Read + Send + 'static,
    overflow: Arc<AtomicBool>,
    total: Arc<std::sync::atomic::AtomicUsize>,
) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut output = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let previous = total.fetch_add(n, Ordering::SeqCst);
                    let remaining = (1024 * 1024usize).saturating_sub(previous);
                    output.extend_from_slice(&buffer[..n.min(remaining)]);
                    if n > remaining {
                        overflow.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            }
        }
        output
    })
}
pub fn run(stage: &Value) -> Value {
    let tid = stage["task_id"].as_str().unwrap_or("");
    let flag = {
        let mut registry = running().lock().unwrap();
        registry
            .entry(tid.into())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    };
    let began = Instant::now();
    let mut started = false;
    let result = (|| -> Result<Value, String> {
        let d = &stage["definition"];
        let scope = &stage["scope"];
        let folder = Path::new(
            stage["work_dir"]
                .as_str()
                .ok_or("PrivateDirectoryRequired")?,
        );
        fs::create_dir_all(folder).map_err(|_| "CommandWorkDirectoryUnavailable")?;
        let mut command = Command::new(stage["executable"].as_str().ok_or("ProgramRequired")?);
        command
            .env_clear()
            .current_dir(stage["path"].as_str().ok_or("CwdRequired")?)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(0x08000000);
        // Explicit minimal process environment: no inherited provider/IPC credentials.
        for name in ["SystemRoot", "WINDIR", "TEMP", "TMP", "USERPROFILE"] {
            if let Some(v) = std::env::var_os(name) {
                command.env(name, v);
            }
        }
        command
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUTF8", "1");
        for (i, root) in scope["roots"]
            .as_array()
            .ok_or("RootsRequired")?
            .iter()
            .enumerate()
        {
            command.env(
                format!("AEVORA_ROOT{}", i + 1),
                root["path"].as_str().ok_or("RootRequired")?,
            );
        }
        let script = d["script"].as_str().ok_or("ScriptRequired")?;
        if !script.is_empty() {
            let path = folder.join(if d["program"] == "python" {
                "reviewed.py"
            } else {
                "reviewed.ps1"
            });
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(|_| "ReviewedScriptAlreadyStaged")?;
            if d["program"] == "powershell" {
                f.write_all(
                    b"\xef\xbb\xbf[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();\r\n",
                )
                .map_err(|_| "ScriptStageFailed")?;
            }
            f.write_all(script.as_bytes())
                .map_err(|_| "ScriptStageFailed")?;
            if d["program"] == "python" {
                command.args(["-I", "-B", "-X", "utf8"]).arg(&path);
            } else {
                command
                    .args([
                        "-NoLogo",
                        "-NoProfile",
                        "-NonInteractive",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                    ])
                    .arg(&path);
            }
        } else if d["program"] == "powershell" {
            command.args(["-NoLogo", "-NoProfile", "-NonInteractive"]);
        }
        for arg in d["args"].as_array().ok_or("ArgsRequired")? {
            let value = arg.as_str().ok_or("ArgumentRequired")?;
            if let Some(reference) = value.strip_prefix('@') {
                let (root, relative) = reference
                    .split_once('/')
                    .ok_or("ResourceArgumentRequired")?;
                command.arg(crate::general_host::resolve(scope, root, relative, false)?);
            } else {
                command.arg(value);
            }
        }
        // Preserve existing output contents before the explicitly reviewed script can update them.
        for (i, output) in stage["outputs"]
            .as_array()
            .ok_or("OutputsRequired")?
            .iter()
            .enumerate()
        {
            if output["version"] != "new" {
                fs::copy(
                    output["absolute"].as_str().ok_or("OutputPathRequired")?,
                    folder.join(format!("before-{i}")),
                )
                .map_err(|_| "RecoveryCopyUnavailable")?;
            }
        }
        let job = crate::job::ProcessJob::new().map_err(|_| "ProcessJobUnavailable")?;
        if flag.load(Ordering::SeqCst) {
            return Err("CommandCancelledBeforeStart".into());
        }
        let mut child = command.spawn().map_err(|_| "CommandStartFailed")?;
        started = true;
        if job.assign(&child).is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("ProcessJobAssignmentFailed".into());
        }
        let overflow = Arc::new(AtomicBool::new(false));
        let total = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let out = capture(
            child.stdout.take().ok_or("StdoutUnavailable")?,
            overflow.clone(),
            total.clone(),
        );
        let err = capture(
            child.stderr.take().ok_or("StderrUnavailable")?,
            overflow.clone(),
            total,
        );
        let timeout = scope["command_timeout_seconds"]
            .as_u64()
            .unwrap_or(60)
            .min(120);
        let mut interrupted = None;
        let status = loop {
            if flag.load(Ordering::SeqCst) {
                interrupted = Some("CommandCancelled");
            } else if began.elapsed() >= Duration::from_secs(timeout) {
                interrupted = Some("CommandTimeout");
            } else if overflow.load(Ordering::SeqCst) {
                interrupted = Some("CommandOutputLimit");
            }
            if interrupted.is_some() {
                job.terminate();
                break child.wait().map_err(|_| "CommandWaitFailed")?;
            }
            if let Some(status) = child.try_wait().map_err(|_| "CommandWaitFailed")? {
                break status;
            }
            thread::sleep(Duration::from_millis(25));
        };
        job.terminate(); // Also closes pipes held by descendants after the parent exits.
        let stdout = out.join().map_err(|_| "StdoutCaptureFailed")?;
        let stderr = err.join().map_err(|_| "StderrCaptureFailed")?;
        fs::write(folder.join("stdout.txt"), &stdout).map_err(|_| "CommandLogSaveFailed")?;
        fs::write(folder.join("stderr.txt"), &stderr).map_err(|_| "CommandLogSaveFailed")?;
        let stdout = String::from_utf8_lossy(&stdout);
        let stderr = String::from_utf8_lossy(&stderr);
        let mut products = Vec::new();
        let mut missing = false;
        for output in stage["outputs"].as_array().unwrap() {
            let path = crate::general_host::resolve(
                scope,
                output["root"].as_str().unwrap(),
                output["path"].as_str().unwrap(),
                false,
            )?;
            match crate::general_host::bytes(&path, 8 * 1024 * 1024){Ok(data) if data.len()<=8*1024*1024=>products.push(json!({"root":output["root"],"path":output["path"],"version":crate::document_resources::digest(&data),"bytes":data.len()})),_=>missing=true}
        }
        let error = interrupted.or(if !status.success() {
            Some("CommandExitNonzero")
        } else if missing {
            Some("DeclaredOutputMissing")
        } else {
            None
        });
        // A completed failed command is a real observation; interruption leaves possible effects unknown.
        Ok(
            json!({"outcome":if interrupted.is_some(){"Unknown"}else{"Success"},"status":if error.is_some(){"Failed"}else{"Success"},"error":error,"exit_code":status.code(),"stdout":stdout.chars().take(4096).collect::<String>(),"stderr":stderr.chars().take(4096).collect::<String>(),"truncated":stdout.chars().count()>4096||stderr.chars().count()>4096||overflow.load(Ordering::SeqCst),"products":products,"verification":if missing{"DeclaredOutputMissing"}else{"Observed"},"elapsed_ms":began.elapsed().as_millis(),"log_directory":folder}),
        )
    })();
    running().lock().unwrap().remove(tid);
    let mut receipt = result.unwrap_or_else(
        |error| json!({"outcome":if started{"Unknown"}else{"NotExecuted"},"error":error}),
    );
    for key in ["agent_id", "task_id", "action_id"] {
        receipt[key] = stage[key].clone();
    }
    receipt
}
