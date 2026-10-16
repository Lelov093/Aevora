//! Renderer visibility is independent of Runtime, Proactivity and foreground audio.
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder,
};
// Space for the approved 98px Orb, its glow and a readable state label.
const COLLAPSED_SIZE: (f64, f64) = (132.0, 150.0);
pub struct Presence {
    config: Mutex<Value>,
    data: PathBuf,
    operation: Mutex<()>,
    context: Mutex<Value>,
    position_epoch: AtomicU64,
    position_worker: AtomicBool,
}
impl Presence {
    pub fn new(data: &Path) -> Arc<Self> {
        let config = fs::read(data.join("presence.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .unwrap_or(json!({"enabled":false,"always_on_top":false}));
        Arc::new(Self {
            config: Mutex::new(config),
            data: data.into(),
            operation: Mutex::new(()),
            context: Mutex::new(Value::Null),
            position_epoch: AtomicU64::new(0),
            position_worker: AtomicBool::new(false),
        })
    }
    pub fn public(&self) -> Value {
        let mut c = self.config.lock().unwrap().clone();
        c["conversation_context"] = self.context.lock().unwrap().clone();
        c
    }
    pub fn set_context(&self, app: &AppHandle, value: &Value) -> Result<Value, String> {
        let r = app.state::<Arc<crate::runtime::Runtime>>();
        let s=r.command(&json!({"protocol_version":1,"command_id":uuid::Uuid::new_v4().to_string(),"type":"GetSnapshot","payload":{}}))?["data"].clone();
        if value["agent_id"] != s["selected_agent_id"]
            || value["conversation_id"] != s["chat"]["selected_conversation_id"]
        {
            return Err("会话已变化，未复用旧目标确认。".into());
        }
        if !value["goal_context"].is_null() {
            let g=r.command(&json!({"protocol_version":1,"command_id":uuid::Uuid::new_v4().to_string(),"type":"GetGoalContext","agent_id":value["agent_id"],"payload":{"goal_id":value["goal_context"]["goal_id"]}}))?["data"].clone();
            let mut approval = value["goal_context"].clone();
            if approval["allow_outbound"] != true {
                return Err("目标资料尚未确认".into());
            }
            approval
                .as_object_mut()
                .ok_or("目标确认无效")?
                .remove("allow_outbound");
            if approval != g["references"] {
                return Err("目标上下文已经失效，请在主窗口重新确认。".into());
            }
        }
        if !value["work_context"].is_null() {
            let work = r.command(&json!({"protocol_version":1,"command_id":uuid::Uuid::new_v4().to_string(),"type":"GetConversationWorkContext","agent_id":value["agent_id"],"payload":{"conversation_id":value["conversation_id"]}}))?["data"].clone();
            let mut approval = value["work_context"].clone();
            if approval["allow_outbound"] != true { return Err("工作资料尚未确认".into()); }
            approval.as_object_mut().ok_or("工作资料确认无效")?.remove("allow_outbound");
            if approval != work["references"] { return Err("工作资料已经改变，请在主窗口重新确认。".into()); }
        }
        *self.context.lock().unwrap() = value.clone();
        let _ = app.emit("presence-context", value);
        Ok(self.public())
    }
    pub fn configure(&self, app: &AppHandle, enabled: bool, top: bool) -> Result<Value, String> {
        let _guard = self.operation.lock().unwrap();
        let old = self.config.lock().unwrap().clone();
        let mut c = old.clone();
        c["enabled"] = json!(enabled);
        c["always_on_top"] = json!(top);
        fs::write(
            self.data.join("presence.json.tmp"),
            serde_json::to_vec(&c).unwrap(),
        )
        .map_err(|_| "Presence 设置保存失败")?;
        fs::rename(
            self.data.join("presence.json.tmp"),
            self.data.join("presence.json"),
        )
        .map_err(|_| "Presence 设置保存失败")?;
        *self.config.lock().unwrap() = c;
        if let Some(w) = app.get_webview_window("presence") {
            let _ = w.set_always_on_top(top);
        }
        if enabled {
            if let Err(e) = self.sync_inner(app) {
                *self.config.lock().unwrap() = old;
                let _ = fs::write(
                    self.data.join("presence.json"),
                    serde_json::to_vec(&*self.config.lock().unwrap()).unwrap(),
                );
                return Err(e);
            }
        } else {
            app.state::<Arc<crate::runtime::Runtime>>()
                .speech
                .cancel(Some("presence"));
            if let Some(w) = app.get_webview_window("presence") {
                let _ = w.hide();
                let _ = app.emit_to("presence", "presence-visibility", false);
            }
            let _ = app.emit("speech-surface-hidden", "presence");
        }
        let _ = app.emit("presence-settings", self.public());
        Ok(self.public())
    }
    pub fn sync(&self, app: &AppHandle) -> Result<(), String> {
        let _guard = self.operation.lock().unwrap();
        self.sync_inner(app)
    }
    fn sync_inner(&self, app: &AppHandle) -> Result<(), String> {
        let main = app.get_webview_window("main");
        let main_visible = main
            .as_ref()
            .is_some_and(|w| w.is_visible().unwrap_or(true) && !w.is_minimized().unwrap_or(false));
        if self.public()["enabled"] != true || main_visible {
            if let Some(w) = app.get_webview_window("presence") {
                app.state::<Arc<crate::runtime::Runtime>>()
                    .speech
                    .cancel(Some("presence"));
                let _ = w.hide();
                let _ = app.emit_to("presence", "presence-visibility", false);
                let _ = app.emit("speech-surface-hidden", "presence");
            }
            return Ok(());
        }
        let w = if let Some(w) = app.get_webview_window("presence") {
            w
        } else {
            WebviewWindowBuilder::new(app, "presence", WebviewUrl::App("index.html".into()))
                .title("Aevora · 快速交流")
                .inner_size(COLLAPSED_SIZE.0, COLLAPSED_SIZE.1)
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .always_on_top(self.public()["always_on_top"] == true)
                .skip_taskbar(true)
                .visible(false)
                .focused(false)
                .build()
                .map_err(|_| "轻量窗口创建失败")?
        };
        if !w.is_visible().unwrap_or(false) {
            self.place(&w, self.saved_anchor())?;
            w.show().map_err(|_| "轻量窗口显示失败")?;
            let _ = app.emit_to("presence", "presence-visibility", true);
        }
        Ok(())
    }
    pub fn expand(&self, app: &AppHandle, expanded: bool) -> Result<(), String> {
        let _guard = self.operation.lock().unwrap();
        let w = app.get_webview_window("presence").ok_or("轻量窗口不可用")?;
        let at = w.outer_position().map_err(|_| "窗口位置不可用")?;
        let size = w.outer_size().map_err(|_| "窗口尺寸不可用")?;
        let anchor = (at.x + size.width as i32, at.y + size.height as i32);
        let monitor = w.current_monitor().map_err(|_| "屏幕信息不可用")?;
        let scale = w.scale_factor().map_err(|_| "窗口缩放信息不可用")?;
        let available = monitor.as_ref().map(|m| m.work_area().size);
        let (width, height) = if expanded { (400.0_f64, 600.0_f64) } else { COLLAPSED_SIZE };
        w.set_size(if expanded {
            LogicalSize::new(
                width.min(available.map_or(width, |s| s.width as f64 / scale)),
                height.min(available.map_or(height, |s| s.height as f64 / scale)),
            )
        } else {
            LogicalSize::new(COLLAPSED_SIZE.0, COLLAPSED_SIZE.1)
        })
        .map_err(|_| "轻量窗口尺寸调整失败")?;
        self.place(&w, Some(anchor))?;
        Ok(())
    }

    fn saved_anchor(&self) -> Option<(i32, i32)> {
        let config = self.config.lock().unwrap();
        Some((i32::try_from(config["position"]["right"].as_i64()?).ok()?,
              i32::try_from(config["position"]["bottom"].as_i64()?).ok()?))
    }

    fn place(&self, w: &tauri::WebviewWindow, anchor: Option<(i32, i32)>) -> Result<(), String> {
        let monitors = w.available_monitors().map_err(|_| "屏幕信息不可用")?;
        let areas: Vec<Area> = monitors.iter().map(|m| {
            let a = m.work_area();
            Area { x: a.position.x, y: a.position.y, width: a.size.width, height: a.size.height }
        }).collect();
        let default = w.primary_monitor().map_err(|_| "主屏信息不可用")?
            .map(|m| {let a=m.work_area(); (a.position.x+a.size.width as i32-24, a.position.y+a.size.height as i32-24)});
        let anchor = anchor.or(default).ok_or("屏幕信息不可用")?;
        let area = nearest_area(&areas, anchor).ok_or("屏幕信息不可用")?;
        let size = w.outer_size().map_err(|_| "窗口尺寸不可用")?;
        let position = clamped_position(area, anchor, (size.width, size.height));
        if w.outer_position().map_err(|_| "窗口位置不可用")? != position {
            w.set_position(position).map_err(|_| "窗口位置调整失败")?;
        }
        Ok(())
    }

    fn save_config(&self, value: &Value) -> Result<(), String> {
        fs::write(self.data.join("presence.json.tmp"), serde_json::to_vec(value).unwrap())
            .map_err(|_| "Presence 位置保存失败")?;
        fs::rename(self.data.join("presence.json.tmp"), self.data.join("presence.json"))
            .map_err(|_| "Presence 位置保存失败")?;
        *self.config.lock().unwrap() = value.clone();
        Ok(())
    }

    pub fn reset_position(&self, app: &AppHandle) -> Result<Value, String> {
        let _guard = self.operation.lock().unwrap();
        let mut config = self.config.lock().unwrap().clone();
        config.as_object_mut().ok_or("Presence 设置不可用")?.remove("position");
        self.save_config(&config)?;
        if let Some(w) = app.get_webview_window("presence") { self.place(&w, None)?; }
        Ok(self.public())
    }

    fn remember_position(&self, app: &AppHandle) -> Result<(), String> {
        let _guard = self.operation.lock().unwrap();
        let Some(w) = app.get_webview_window("presence") else { return Ok(()); };
        if !w.is_visible().unwrap_or(false) { return Ok(()); }
        let at = w.outer_position().map_err(|_| "窗口位置不可用")?;
        let size = w.outer_size().map_err(|_| "窗口尺寸不可用")?;
        self.place(&w, Some((at.x+size.width as i32, at.y+size.height as i32)))?;
        let at = w.outer_position().map_err(|_| "窗口位置不可用")?;
        let mut config = self.config.lock().unwrap().clone();
        config["position"] = json!({"right":at.x+size.width as i32,"bottom":at.y+size.height as i32});
        self.save_config(&config)
    }
}

#[derive(Clone, Copy)]
struct Area { x: i32, y: i32, width: u32, height: u32 }

fn nearest_area(areas: &[Area], anchor: (i32, i32)) -> Option<Area> {
    areas.iter().copied().min_by_key(|a| {
        let (x,y) = (anchor.0 as i64-1, anchor.1 as i64-1);
        let dx=x-x.clamp(a.x as i64, a.x as i64+a.width as i64-1);
        let dy=y-y.clamp(a.y as i64, a.y as i64+a.height as i64-1);
        dx*dx+dy*dy
    })
}

fn clamped_position(area: Area, anchor: (i32,i32), size: (u32,u32)) -> PhysicalPosition<i32> {
    PhysicalPosition::new(
        (anchor.0 as i64-size.0 as i64).clamp(area.x as i64,area.x as i64+area.width.saturating_sub(size.0) as i64) as i32,
        (anchor.1 as i64-size.1 as i64).clamp(area.y as i64,area.y as i64+area.height.saturating_sub(size.1) as i64) as i32,
    )
}

pub fn remember_later(app: AppHandle) {
    let presence = app.state::<Arc<Presence>>().inner().clone();
    presence.position_epoch.fetch_add(1, Ordering::SeqCst);
    if presence.position_worker.swap(true, Ordering::SeqCst) { return; }
    tauri::async_runtime::spawn_blocking(move || {
        let epoch = loop {
            let epoch = presence.position_epoch.load(Ordering::SeqCst);
            std::thread::sleep(std::time::Duration::from_millis(300));
            if presence.position_epoch.load(Ordering::SeqCst) == epoch { break epoch; }
        };
        if let Err(e) = presence.remember_position(&app) { let _=app.emit("runtime-control-error",e); }
        presence.position_worker.store(false, Ordering::SeqCst);
        if presence.position_epoch.load(Ordering::SeqCst) != epoch { remember_later(app); }
    });
}

pub fn sync_later(app: AppHandle) {
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = app.state::<Arc<Presence>>().sync(&app) {
            let _ = app.emit("runtime-control-error", e);
        }
    });
}
