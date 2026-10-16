use crate::{runtime::Runtime, show_main};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::{menu::MenuItem, AppHandle, Emitter, Listener, Manager};
use uuid::Uuid;

pub struct Controls {
    app: AppHandle,
    runtime: Arc<Runtime>,
    pub status: MenuItem<tauri::Wry>,
    pub pause: MenuItem<tauri::Wry>,
    pub resume: MenuItem<tauri::Wry>,
    operation: Mutex<()>,
}

pub fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "show" => {
            let _ = show_main(app);
        }
        "quit" => app.exit(0),
        "pause" | "resume" => {
            let controls = app.state::<Arc<Controls>>().inner().clone();
            let paused = id == "pause";
            tauri::async_runtime::spawn_blocking(move || {
                let _ = controls.set_paused(paused);
            });
        }
        _ => {}
    }
}

impl Controls {
    pub fn new(app: AppHandle, runtime: Arc<Runtime>) -> tauri::Result<Arc<Self>> {
        Ok(Arc::new(Self {
            status: MenuItem::with_id(
                &app,
                "runtime-state",
                "Runtime 正在连接",
                false,
                None::<&str>,
            )?,
            pause: MenuItem::with_id(&app, "pause", "暂停后台工作", false, None::<&str>)?,
            resume: MenuItem::with_id(&app, "resume", "恢复后台工作", false, None::<&str>)?,
            app,
            runtime,
            operation: Mutex::new(()),
        }))
    }

    fn snapshot(&self) -> Result<Value, String> {
        Ok(self.runtime.command(&json!({"protocol_version":1,
            "command_id":Uuid::new_v4().to_string(), "type":"GetSnapshot", "payload":{}}))?["data"]
            .clone())
    }

    fn display(&self, snapshot: &Value) {
        let paused = snapshot["runtime_state"] == "Paused";
        let notices = snapshot["proactivity"]["notices"].as_array().map(|items| items.iter().filter(|n| n["state"] == "Notified").count()).unwrap_or(0);
        let text = if paused {
            "Runtime 已暂停（前台对话可用）".to_string()
        } else if notices > 0 {
            format!("Runtime 运行中 · {notices} 条主动跟进待看")
        } else {
            "Runtime 运行中".to_string()
        };
        let _ = self.status.set_text(text);
        let _ = self.pause.set_enabled(!paused);
        let _ = self.resume.set_enabled(paused);
    }

    fn refresh(&self) {
        let _guard = self.operation.lock().unwrap();
        if self.runtime.status.lock().unwrap().status == "Ready" {
            if let Ok(snapshot) = self.snapshot() {
                self.display(&snapshot);
                return;
            }
        }
        let _ = self.status.set_text("Runtime 不可用 / 正在连接");
        let _ = self.pause.set_enabled(false);
        let _ = self.resume.set_enabled(false);
    }

    // The native menu and debug-only integration probe use this same operation.
    // Explicit Pause/Resume avoids inverting a state changed by another window.
    pub fn set_paused(&self, paused: bool) -> Result<(), String> {
        let _guard = self.operation.lock().unwrap();
        let result = (|| {
            let before = self.snapshot()?;
            if (before["runtime_state"] == "Paused") != paused {
                self.runtime.command(&json!({"protocol_version":1,
                    "command_id":Uuid::new_v4().to_string(),
                    "type":if paused {"Pause"} else {"Resume"},
                    "expected_revision":before["revision"], "payload":{}}))?;
            }
            self.display(&self.snapshot()?);
            Ok(())
        })();
        if result.is_err() {
            // Do not silently retry a revision conflict or report an unsaved state.
            if let Ok(snapshot) = self.snapshot() {
                self.display(&snapshot);
            } else {
                let _ = self.pause.set_enabled(false);
                let _ = self.resume.set_enabled(false);
            }
            let _ = self.status.set_text("操作未确认成功，请查看主窗口并重试");
            let _ = self.app.emit(
                "runtime-control-error",
                "后台暂停/恢复未确认成功。请检查 Runtime 状态后重试。",
            );
            let _ = show_main(&self.app);
        }
        result
    }

    pub fn listen(self: &Arc<Self>) {
        let controls = self.clone();
        self.app.listen("host-status", move |_| {
            let controls = controls.clone();
            tauri::async_runtime::spawn_blocking(move || controls.refresh());
        });
        let controls = self.clone();
        self.app.listen("runtime-event", move |event| {
            let value: Value = serde_json::from_str(event.payload()).unwrap_or(Value::Null);
            if matches!(
                value["type"].as_str(),
                Some("Handshake" | "RuntimePaused" | "RuntimeResumed" | "ProactiveNotified" | "DismissProactiveNotice" | "SnoozeProactiveNotice" | "HandleProactiveNotice" | "ConfigureProactivity" | "GoalDeleted" | "GoalStateChanged" | "GoalEdited" | "SaveTaskFeedback" | "DeleteTaskFeedback")
            ) {
                let controls = controls.clone();
                tauri::async_runtime::spawn_blocking(move || controls.refresh());
            }
        });
    }
}
