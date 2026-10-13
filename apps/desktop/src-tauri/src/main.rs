#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod audio;
mod job;
mod network;
mod planned_host;
mod presence;
mod provider;
mod runtime;
mod speech;
mod speech_config;
mod tools;
mod tray;
use runtime::Runtime;
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};
use tauri::{Emitter, Manager};

#[tauri::command]
async fn runtime_command(
    runtime: tauri::State<'_, Arc<Runtime>>,
    command: Value,
) -> Result<Value, String> {
    // Host exposes only implemented domain commands, never arbitrary URLs.
    if !matches!(
        command["type"].as_str(),
        Some(
            "GetSnapshot"
                | "Pause"
                | "Resume"
                | "CreateAgent"
                | "ListAgents"
                | "SelectAgent"
                | "GetAgent"
                | "GetPersonaHistory"
                | "EditPersona"
                | "CreateConversation"
                | "SelectConversation"
                | "ListConversations"
                | "ListMessages"
                | "SendMessage"
                | "GetRun"
                | "CancelRun"
                | "ConfigureProvider"
                | "ListMemories"
                | "GetMemory"
                | "GetMemorySettings"
                | "ListMemoryJobs"
                | "ConfigureMemory"
                | "ReviewMemory"
                | "RetryMemoryJob"
                | "EditMemory"
                | "ForgetMemory"
                | "DeleteMemory"
                | "DeleteConversation"
                | "ListConversationMemories"
                | "ListEmbeddingJobs"
                | "RetryEmbeddingJob"
                | "SearchMemories"
                | "CreateTask"
                | "CreatePlannedTask"
                | "ApproveTaskPlan"
                | "EditTaskPlan"
                | "EditTaskBody"
                | "CreateNetworkTask"
                | "EditNetworkQueries"
                | "SelectNetworkSources"
                | "ApproveNetworkRedirect"
                | "SkipNetworkSource"
                | "ConfigureSearch"
                | "ListSchedules"
                | "ConfigureScheduler"
                | "CreateSchedule"
                | "EditSchedule"
                | "CancelSchedule"
                | "DismissSchedule"
                | "CreateCommitment"
                | "GetCommitmentSource"
                | "CreateGoal"
                | "ListGoals"
                | "GetGoal"
                | "EditGoal"
                | "ChangeGoalState"
                | "DeleteGoal"
                | "LinkGoalWork"
                | "UnlinkGoalWork"
                | "GetGoalContext"
                | "GetGoalSource"
                | "RejectWorkSuggestion"
                | "PrepareFileWork"
                | "SaveTaskFeedback"
                | "DeleteTaskFeedback"
                | "ListMethods"
                | "GetMethodExperience"
                | "CreateMethodProposal"
                | "EditMethodCandidate"
                | "StartMethodEvaluation"
                | "RecordMethodEvaluation"
                | "AdoptMethod"
                | "EnableMethod"
                | "DisableMethod"
                | "RollbackMethod"
                | "RejectMethod"
                | "DeleteMethod"
                | "GetProactivity"
                | "PreviewProactivityContext"
                | "ConfigureProactivity"
                | "DismissProactiveNotice"
                | "SnoozeProactiveNotice"
                | "HandleProactiveNotice"
                | "SetGoalFollowupPolicy"
                | "SetConversationGoal"
                | "GetConversationWorkContext"
                | "GetConversationWorkResponses"
                | "ListTasks"
                | "GetTask"
                | "RetryTask"
                | "PauseTask"
                | "CancelTask"
                | "ApproveTask"
                | "RejectTask"
                | "RevokeTaskPermission"
                | "ResolveTask"
                | "PreviewTaskArtifact"
        )
    ) {
        return Err("ValidationError: command is unavailable".into());
    }
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || runtime.command(&command))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
fn host_status(runtime: tauri::State<'_, Arc<Runtime>>) -> runtime::Status {
    runtime.status.lock().unwrap().clone()
}
#[tauri::command]
async fn choose_task_resource(kind: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || tools::choose(&kind))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn hide_main(app: tauri::AppHandle) {
    app.state::<Arc<Runtime>>().speech.cancel(Some("main"));
    let _ = app.emit("speech-surface-hidden", "main");
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    presence::sync_later(app.clone());
}
#[tauri::command]
async fn speech_command(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    runtime: tauri::State<'_, Arc<Runtime>>,
    payload: Value,
) -> Result<Value, String> {
    let r = runtime.inner().clone();
    let owner = window.label().to_string();
    if !matches!(owner.as_str(), "main" | "presence") {
        return Err("此窗口不能访问语音控制".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let speech = r.speech.clone();
        let action = payload["action"].as_str().ok_or("语音操作缺失")?;
        match action {
            "snapshot" => Ok(speech.public()),
            "configure" => {
                speech.cancel(None);
                speech.vault.lock().unwrap().configure(&payload["config"])?;
                let _ = app.emit("speech-settings", speech.public());
                Ok(speech.public())
            }
            "import_env" => {
                speech.cancel(None);
                speech.vault.lock().unwrap().import(&r.root)?;
                let _ = app.emit("speech-settings", speech.public());
                Ok(speech.public())
            }
            "stop" => {
                speech.cancel(None);
                let _ = app.emit("speech-event", speech.public()["activity"].clone());
                Ok(speech.public())
            }
            "cancel_owned" => {
                speech.cancel(Some(&owner));
                Ok(speech.public())
            }
            "end_capture" => {
                speech.end_capture(
                    &owner,
                    payload["operation_id"].as_str().ok_or("轮次标识缺失")?,
                )?;
                Ok(speech.public())
            }
            "begin_capture" | "speak" => {
                let w = app.get_webview_window(&owner).ok_or("来源窗口已关闭")?;
                if !w.is_visible().unwrap_or(false) || w.is_minimized().unwrap_or(true) {
                    return Err("请在可见窗口开始语音。".into());
                }
                let aid = payload["agent_id"].as_str().ok_or("Agent缺失")?;
                let cid = payload["conversation_id"].as_str().ok_or("会话缺失")?;
                if action == "begin_capture" {
                    speech.start_capture(app, r, &owner, aid, cid)
                } else {
                    speech.speak(app, r, &owner, aid, cid, &payload["source"])
                }
            }
            _ => Err("不支持的语音操作".into()),
        }
    })
    .await
    .map_err(|_| "语音操作中断".to_string())?
}
#[tauri::command]
async fn presence_command(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    payload: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = app.state::<Arc<presence::Presence>>();
        match payload["action"].as_str() {
            Some("snapshot") => Ok(p.public()),
            Some("goal_context") if window.label() == "main" => {
                p.set_context(&app, &payload["context"])
            }
            Some("configure") => p.configure(
                &app,
                payload["enabled"] == true,
                payload["always_on_top"] == true,
            ),
            Some("expand") if window.label() == "presence" => {
                p.expand(&app, payload["expanded"] == true)?;
                Ok(p.public())
            }
            Some("drag") if window.label() == "presence" => {
                window.start_dragging().map_err(|_| "窗口拖动不可用")?;
                Ok(p.public())
            }
            Some("reset_position") => p.reset_position(&app),
            Some("open_main") => {
                show_main(&app).map_err(|_| "主窗口无法打开")?;
                let _ = app.emit("presence-open", payload["context"].clone());
                Ok(p.public())
            }
            _ => Err("Presence操作不可用".into()),
        }
    })
    .await
    .map_err(|_| "Presence操作中断".to_string())?
}
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}
pub fn show_main(app: &tauri::AppHandle) -> tauri::Result<()> {
    let window = if let Some(w) = app.get_webview_window("main") {
        w
    } else {
        tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?.build()?
    };
    window.show()?;
    window.unminimize()?;
    window.set_focus()?;
    if let Some(p) = app.try_state::<Arc<presence::Presence>>() {
        let _ = p.sync(app);
    }
    Ok(())
}
fn main() {
    let root = std::env::var_os("AEVORA_PROJECT_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."));
    let data = std::env::var_os("AEVORA_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(".data"));

    let runtime = Runtime::new(root, data).expect("Cannot initialize native runtime");
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let _ = show_main(app);
        }))
        .manage(runtime.clone())
        .manage(presence::Presence::new(&runtime.data))
        .invoke_handler(tauri::generate_handler![
            runtime_command,
            choose_task_resource,
            host_status,
            hide_main,
            speech_command,
            presence_command,
            quit_app
        ])
        .setup(move |app| {
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::TrayIconBuilder;
            let show = MenuItem::with_id(app, "show", "打开 Aevora", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 Runtime", true, None::<&str>)?;
            let controls = tray::Controls::new(app.handle().clone(), runtime.clone())?;
            let menu = Menu::with_items(
                app,
                &[
                    &show,
                    &controls.status,
                    &controls.pause,
                    &controls.resume,
                    &quit,
                ],
            )?;
            app.manage(controls.clone());
            controls.listen();
            let mut pixels = vec![0u8; 32 * 32 * 4];
            for p in pixels.chunks_mut(4) {
                p.copy_from_slice(&[120, 193, 176, 255]);
            }
            TrayIconBuilder::new()
                .icon(tauri::image::Image::new_owned(pixels, 32, 32))
                .tooltip("Aevora")
                .menu(&menu)
                .on_menu_event(|app, event| tray::handle_menu(app, event.id.as_ref()))
                .build(app)?;
            runtime.start(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "presence"
                && matches!(
                    event,
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
                )
            {
                presence::remember_later(window.app_handle().clone());
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                window
                    .app_handle()
                    .state::<Arc<Runtime>>()
                    .speech
                    .cancel(Some(window.label()));
                let _ = window
                    .app_handle()
                    .emit("speech-surface-hidden", window.label());
                let _ = window.hide();
                if window.label() == "main" {
                    presence::sync_later(window.app_handle().clone());
                } else if window.label() == "presence" {
                    let p = window.app_handle().state::<Arc<presence::Presence>>();
                    let _ = p.configure(
                        window.app_handle(),
                        false,
                        p.public()["always_on_top"] == true,
                    );
                }
            }
            if let tauri::WindowEvent::Focused(false) = event {
                let r = window.app_handle().state::<Arc<Runtime>>();
                let active = r.speech.active.lock().unwrap().clone();
                if active.is_some_and(|o| o.owner == window.label() && o.kind == "asr") {
                    r.speech.cancel(Some(window.label()));
                }
            }
            if let tauri::WindowEvent::Resized(_) = event {
                if window.label() == "main" {
                    presence::sync_later(window.app_handle().clone());
                    if window.is_minimized().unwrap_or(false) {
                        window
                            .app_handle()
                            .state::<Arc<Runtime>>()
                            .speech
                            .cancel(Some("main"));
                        let _ = window.app_handle().emit("speech-surface-hidden", "main");
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Cannot create Aevora desktop");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } = &event
        {
            // Destroying the final WebView must not end the tray Host/Core.
            api.prevent_exit();
        }
        if matches!(event, tauri::RunEvent::Exit) {
            app.state::<Arc<Runtime>>().stop();
        }
    });
}
