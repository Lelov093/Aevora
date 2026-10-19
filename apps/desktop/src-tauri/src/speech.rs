//! One audio owner across all windows. Models never issue these commands or change speech grants.
use crate::{runtime::Runtime, speech_config::Vault};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    net::{TcpStream, ToSocketAddrs},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use tungstenite::{client::IntoClientRequest, stream::MaybeTlsStream, Message, WebSocket};
use uuid::Uuid;

pub struct Operation {
    pub id: String,
    pub owner: String,
    pub agent: String,
    pub conversation: String,
    pub kind: String,
    pub cancel: Arc<AtomicBool>,
    pub input_done: Arc<AtomicBool>,
    pub recording: Arc<AtomicBool>,
    sink: Mutex<Option<Arc<rodio::Sink>>>,
    pub view: Mutex<Value>,
}
pub struct Speech {
    pub vault: Mutex<Vault>,
    pub active: Mutex<Option<Arc<Operation>>>,
}
impl Speech {
    pub fn new(root: &Path, data: &Path) -> Arc<Self> {
        let vault = Vault::load(root, data);
        Arc::new(Self {
            vault: Mutex::new(vault),
            active: Mutex::new(None),
        })
    }
    pub fn public(&self) -> Value {
        let active = self.active.lock().unwrap().clone();
        let mut v = json!({"config":self.vault.lock().unwrap().public(),"activity":null});
        if let Some(o) = active {
            let mut a = o.view.lock().unwrap().clone();
            a["recording"] = json!(o.recording.load(Ordering::SeqCst));
            a["playback_active"] =
                json!(o.sink.lock().unwrap().as_ref().is_some_and(|s| !s.empty()));
            v["activity"] = a;
        }
        v
    }
    pub fn cancel(&self, owner: Option<&str>) {
        if let Some(o) = self.active.lock().unwrap().as_ref() {
            if owner.is_none() || owner == Some(o.owner.as_str()) {
                o.cancel.store(true, Ordering::SeqCst);
                o.input_done.store(true, Ordering::SeqCst);
                if let Some(sink) = o.sink.lock().unwrap().as_ref() {
                    sink.stop();
                }
                o.view.lock().unwrap()["state"] = json!("Cancelled");
            }
        }
    }
    pub fn end_capture(&self, owner: &str, id: &str) -> Result<(), String> {
        let a = self.active.lock().unwrap();
        let o = a.as_ref().ok_or("当前没有采音轮次")?;
        if o.owner != owner || o.id != id || o.kind != "asr" {
            return Err("此采音轮次已改变".into());
        }
        o.input_done.store(true, Ordering::SeqCst);
        Ok(())
    }
    fn context(runtime: &Runtime, agent: &str, cid: &str) -> Result<Value, String> {
        let s=runtime.command(&json!({"protocol_version":1,"command_id":Uuid::new_v4().to_string(),"type":"GetSnapshot","payload":{}}))?["data"].clone();
        if s["selected_agent_id"] != agent || s["chat"]["selected_conversation_id"] != cid {
            return Err("Agent 或会话已经改变，请重新开始本轮语音。".into());
        }
        Ok(s)
    }
    pub fn validate_context(&self, runtime: &Runtime) {
        let o = self.active.lock().unwrap().clone();
        if let Some(o) = o {
            if matches!(
                o.view.lock().unwrap()["state"].as_str(),
                Some("Completed" | "Failed" | "Cancelled")
            ) {
                return;
            }
            if Self::context(runtime, &o.agent, &o.conversation).is_err() {
                self.cancel(None);
            } else if o.kind == "tts" {
                let v = o.view.lock().unwrap().clone();
                if self
                    .source(
                        runtime,
                        &o.agent,
                        &o.conversation,
                        &json!({"kind":v["source_kind"],"id":v["source_id"]}),
                    )
                    .is_err()
                {
                    self.cancel(None);
                }
            }
        }
    }
    fn new_operation(
        &self,
        owner: &str,
        agent: &str,
        cid: &str,
        kind: &str,
        reserve: f64,
    ) -> Result<(Arc<Operation>, Value), String> {
        let mut a = self.active.lock().unwrap();
        if a.as_ref().is_some_and(|o| {
            !matches!(
                o.view.lock().unwrap()["state"].as_str(),
                Some("Completed" | "Failed" | "Cancelled")
            )
        }) {
            return Err("另一个音频轮次仍在进行，请先停止。".into());
        }
        let id = Uuid::new_v4().to_string();
        let config = self.vault.lock().unwrap().reserve(kind, &id, reserve)?;
        let o = Arc::new(Operation {
            id: id.clone(),
            owner: owner.into(),
            agent: agent.into(),
            conversation: cid.into(),
            kind: kind.into(),
            cancel: Arc::new(AtomicBool::new(false)),
            input_done: Arc::new(AtomicBool::new(false)),
            recording: Arc::new(AtomicBool::new(false)),
            sink: Mutex::new(None),
            view: Mutex::new(
                json!({"operation_id":id,"owner":owner,"agent_id":agent,"conversation_id":cid,"kind":kind,"state":"Connecting","text":"","error":null}),
            ),
        });
        *a = Some(o.clone());
        Ok((o, config))
    }
    fn publish(&self, app: &AppHandle, o: &Operation, patch: Value) {
        if o.cancel.load(Ordering::SeqCst) {
            return;
        }
        {
            let mut v = o.view.lock().unwrap();
            for (k, x) in patch.as_object().unwrap() {
                v[k] = x.clone();
            }
        }
        let _ = app.emit("speech-event", o.view.lock().unwrap().clone());
    }
    fn usage(&self, id: &str, patch: Value) -> Result<(), String> {
        self.vault.lock().unwrap().update_usage(id, &patch)
    }
    fn finish(&self, app: &AppHandle, o: &Operation, result: Result<(), String>) {
        o.input_done.store(true, Ordering::SeqCst);
        let state = if o.cancel.load(Ordering::SeqCst) {
            "Cancelled"
        } else if result.is_ok() {
            "Completed"
        } else {
            "Failed"
        };
        {
            let mut v = o.view.lock().unwrap();
            v["state"] = json!(state);
            v["error"] = json!(result.err());
        }
        if let Err(e) = self.usage(
            &o.id,
            json!({"state":state,"finished_at":chrono::Utc::now().to_rfc3339()}),
        ) {
            self.vault.lock().unwrap().error = Some(e.clone());
            o.view.lock().unwrap()["error"] = json!(e);
        }
        // Emit completed/cancelled metadata, never play late results.
        let _ = app.emit("speech-event", o.view.lock().unwrap().clone());
    }

    fn source(
        &self,
        r: &Runtime,
        agent: &str,
        cid: &str,
        source: &Value,
    ) -> Result<String, String> {
        let s = Self::context(r, agent, cid)?;
        let id = source["id"].as_str().ok_or("朗读来源缺失")?;
        match source["kind"].as_str() {
            Some("message") => {
                let m = s["chat"]["messages"]
                    .as_array()
                    .and_then(|ms| ms.iter().find(|m| m["message_id"] == id))
                    .ok_or("原回复已经删除或不在当前会话")?;
                if m["role"] != "assistant" || m["finality"] != "final" {
                    return Err("只朗读完整保存的 Agent 回复。".into());
                }
                let run = s["chat"]["runs"]
                    .as_array()
                    .and_then(|rs| rs.iter().find(|r| r["run_id"] == m["run_id"]))
                    .ok_or("回复来源不存在")?;
                if run["state"] != "Completed" || run["context"]["context_stale"] == true {
                    return Err("此回复未完整成功保存，或上下文已失效。".into());
                }
                Ok(m["content"].as_str().unwrap_or("").into())
            }
            Some("notice") => {
                let n = s["proactivity"]["notices"]
                    .as_array()
                    .and_then(|ns| {
                        ns.iter()
                            .find(|n| n["check_id"] == id && n["state"] == "Notified")
                    })
                    .ok_or("此通知已处理或不存在")?;
                Ok(n["message"].as_str().unwrap_or("").into())
            }
            Some("schedule") => {
                let n = s["scheduler"]["items"]
                    .as_array()
                    .and_then(|ns| {
                        ns.iter()
                            .find(|n| n["schedule_id"] == id && n["state"] == "Ready")
                    })
                    .ok_or("此到期提醒已处理或不存在")?;
                Ok(format!(
                    "约定提醒：{}。已到约定时间，是否继续由你确认。",
                    n["title"].as_str().unwrap_or("单次约定")
                ))
            }
            Some("task") => {
                let task=r.command(&json!({"protocol_version":1,"command_id":Uuid::new_v4().to_string(),"type":"GetTask","agent_id":agent,"payload":{"task_id":id}}))?["data"].clone();
                let states: Value = serde_json::from_str(include_str!("../../../../packages/protocol/work-states.json"))
                    .map_err(|_| "工作状态资源不可用")?;
                let state = if task["state"] == "Completed" { "执行已完成，可查看保存回执；这不代表长期目标已经达成" }
                    else { states["task"][task["state"].as_str().unwrap_or("")]["label"].as_str().unwrap_or("请打开任务查看当前状态") };
                Ok(format!(
                    "任务：{}。{}。",
                    task["title"].as_str().unwrap_or("文件工作"),
                    state
                ))
            }
            _ => Err("不支持的朗读来源".into()),
        }
    }
    pub fn start_capture(
        self: &Arc<Self>,
        app: AppHandle,
        r: Arc<Runtime>,
        owner: &str,
        agent: &str,
        cid: &str,
    ) -> Result<Value, String> {
        Self::context(&r, agent, cid)?;
        let (o, config) = self.new_operation(owner, agent, cid, "asr", 30.0)?;
        let result = o.view.lock().unwrap().clone();
        let controller = self.clone();
        thread::spawn(move || {
            let buffer = Arc::new(Mutex::new(crate::audio::Buffer::default()));
            let ready = crate::audio::capture(
                o.input_done.clone(),
                o.cancel.clone(),
                o.recording.clone(),
                buffer.clone(),
            );
            let result = (|| -> Result<(), String> {
                let rate = ready
                    .recv_timeout(Duration::from_secs(5))
                    .map_err(|_| "麦克风启动超时")??;
                controller.publish(&app, &o, json!({"state":"Listening","sample_rate":rate}));
                let mut ws = connect(&config, "asr", &o, &controller)?;
                let request = run(
                    &o.id,
                    "asr",
                    &config,
                    json!({"format":"pcm","sample_rate":rate,"vad_model":"near_meeting_16k"}),
                );
                controller.usage(&o.id, json!({"run_task_attempted":true}))?;
                write(&mut ws, request.clone())?;
                let mut events = vec![];
                let mut segments = BTreeMap::new();
                let mut started = false;
                let mut finished = false;
                let mut sent = 0usize;
                let began = Instant::now();
                let result = (|| -> Result<(), String> {
                    loop {
                        if o.cancel.load(Ordering::SeqCst) {
                            return Ok(());
                        }
                        if began.elapsed() > Duration::from_secs(65) {
                            return Err("语音识别超时，未自动重试。".into());
                        }
                        if let Some(e) = buffer.lock().unwrap().error.clone() {
                            return Err(e);
                        }
                        if started && !finished {
                            let chunks: Vec<_> = buffer.lock().unwrap().chunks.drain(..).collect();
                            for b in chunks {
                                if o.cancel.load(Ordering::SeqCst) {
                                    return Ok(());
                                }
                                sent += b.len();
                                controller.usage(
                                    &o.id,
                                    json!({"submitted":sent as f64/(rate as f64*2.0)}),
                                )?;
                                ws.send(Message::Binary(b.into()))
                                    .map_err(|_| "音频发送中断")?;
                            }
                            if o.input_done.load(Ordering::SeqCst)
                                && !o.recording.load(Ordering::SeqCst)
                                && buffer.lock().unwrap().chunks.is_empty()
                            {
                                write(&mut ws, frame(&o.id, "finish-task", json!({})))?;
                                finished = true;
                                controller.publish(&app,&o,json!({"state":"Transcribing","seconds":sent as f64/(rate as f64*2.0),"limit_reached":buffer.lock().unwrap().captured>=29.999}));
                            }
                        }
                        if let Some(e) = read(&mut ws)? {
                            let event = e["header"]["event"].as_str().unwrap_or("");
                            if e["header"]["task_id"] != o.id {
                                return Err("语音服务返回了其他轮次的数据".into());
                            }
                            events.push(e.clone());
                            if let Some(u) = e["payload"].get("usage") {
                                controller
                                    .usage(&o.id, json!({"usage":u,"usage_state":"reported"}))?;
                            }
                            match event {
                                "task-started" => started = true,
                                "result-generated" => {
                                    let sentence = &e["payload"]["output"]["sentence"];
                                    if sentence["heartbeat"] == true {
                                        continue;
                                    }
                                    let id = sentence["sentence_id"]
                                        .as_i64()
                                        .ok_or("语音结果缺少句子标识")?;
                                    let text = sentence["text"].as_str().unwrap_or("");
                                    segments.insert(
                                        id,
                                        (text.to_string(), sentence["sentence_end"] == true),
                                    );
                                    let preview = segments
                                        .values()
                                        .map(|(t, _)| t.as_str())
                                        .collect::<String>();
                                    controller.publish(&app, &o, json!({"text":preview}));
                                }
                                "task-failed" => return Err(service_error(&e)),
                                "task-finished" => {
                                    if !finished || segments.values().any(|(_, end)| !*end) {
                                        return Err("服务未返回完整的最终转写，未发送对话。".into());
                                    }
                                    let text = segments
                                        .values()
                                        .map(|(t, _)| t.as_str())
                                        .collect::<String>();
                                    if text.trim().is_empty() {
                                        return Err(
                                            "没有识别到文字；可以重新说话或直接输入。".into()
                                        );
                                    }
                                    Self::context(&r, &o.agent, &o.conversation)?;
                                    controller.publish(&app,&o,json!({"text":text,"final_text":text,"seconds":sent as f64/(rate as f64*2.0),"elapsed_ms":began.elapsed().as_millis()}));
                                    return Ok(());
                                }
                                _ => {}
                            }
                        }
                    }
                })();
                let _ = ws.close(None);

                result
            })();
            controller.finish(&app, &o, result);
        });
        Ok(result)
    }
    pub fn speak(
        self: &Arc<Self>,
        app: AppHandle,
        r: Arc<Runtime>,
        owner: &str,
        agent: &str,
        cid: &str,
        source: &Value,
    ) -> Result<Value, String> {
        let mut original = self.source(&r, agent, cid, source)?;
        if let Some(index) = source.get("paragraph_index") {
            let index = index.as_u64().ok_or("朗读段落无效")? as usize;
            original = paragraphs(&original)
                .get(index)
                .ok_or("朗读段落已改变")?
                .clone();
        }
        let text = spoken_text(&original);
        if text.trim().is_empty() {
            return Err("该回复没有可朗读的正文。".into());
        }
        if text.chars().count() > 1000 {
            return Err(
                "回复超过单次1000字朗读上限，请先在文字中查看；未静默截断或增加合成请求。".into(),
            );
        }
        let (o, config) =
            self.new_operation(owner, agent, cid, "tts", text.chars().count() as f64)?;
        {
            let mut v = o.view.lock().unwrap();
            v["text"] = json!(text);
            v["source_kind"] = source["kind"].clone();
            v["source_id"] = source["id"].clone();
        }
        let result = o.view.lock().unwrap().clone();
        let controller = self.clone();
        thread::spawn(move || {
            let result = (|| -> Result<(), String> {
                let output = rodio::OutputStreamBuilder::open_default_stream()
                    .map_err(|_| "没有可用的扬声器，文字回复仍保留。")?;
                let sink = Arc::new(rodio::Sink::connect_new(output.mixer()));
                *o.sink.lock().unwrap() = Some(sink.clone());
                let mut ws = connect(&config, "tts", &o, &controller)?;
                let request = run(
                    &o.id,
                    "tts",
                    &config,
                    json!({"text_type":"PlainText","voice":config["tts"]["voice"],"format":"pcm","sample_rate":24000,"rate":config["tts"]["rate"],"enable_ssml":false}),
                );
                controller.usage(&o.id, json!({"run_task_attempted":true}))?;
                write(&mut ws, request.clone())?;
                let mut events = vec![];
                let mut started = false;
                let mut pcm_tail = vec![];
                let began = Instant::now();
                let mut first = true;
                let result = (|| -> Result<(), String> {
                    loop {
                        if o.cancel.load(Ordering::SeqCst) {
                            sink.stop();
                            let _ = write(
                                &mut ws,
                                frame(&o.id, "finish-task", json!({"directive":"cancel"})),
                            );
                            return Ok(());
                        }
                        if began.elapsed() > Duration::from_secs(90) {
                            sink.stop();
                            return Err("语音合成超时，文字回复仍保留。".into());
                        }
                        match ws.read() {
                            Ok(Message::Binary(b)) => {
                                if !started {
                                    return Err("收到未确认轮次的音频".into());
                                }
                                Self::context(&r, &o.agent, &o.conversation)?;
                                if o.cancel.load(Ordering::SeqCst) {
                                    sink.stop();
                                    return Ok(());
                                }
                                pcm_tail.extend_from_slice(&b);
                                let end = pcm_tail.len() / 2 * 2;
                                let samples: Vec<f32> = pcm_tail[..end]
                                    .chunks_exact(2)
                                    .map(|p| i16::from_le_bytes([p[0], p[1]]) as f32 / 32768.0)
                                    .collect();
                                pcm_tail.drain(..end);
                                if !samples.is_empty() {
                                    sink.append(rodio::buffer::SamplesBuffer::new(
                                        1, 24000, samples,
                                    ));
                                    let first_ms = if first {
                                        json!(began.elapsed().as_millis())
                                    } else {
                                        o.view.lock().unwrap()["first_audio_ms"].clone()
                                    };
                                    controller.publish(
                                        &app,
                                        &o,
                                        json!({"state":"Speaking","first_audio_ms":first_ms}),
                                    );
                                    first = false;
                                }
                            }
                            Ok(Message::Text(raw)) => {
                                let e: Value = serde_json::from_str(&raw)
                                    .map_err(|_| "语音服务返回了无效事件")?;
                                if e["header"]["task_id"] != o.id {
                                    return Err("音频轮次不匹配".into());
                                }
                                events.push(e.clone());
                                if let Some(u) = e["payload"].get("usage") {
                                    controller.usage(
                                        &o.id,
                                        json!({"usage":u,"usage_state":"reported"}),
                                    )?;
                                }
                                match e["header"]["event"].as_str() {
                                    Some("task-started") => {
                                        started = true;
                                        controller.usage(
                                            &o.id,
                                            json!({"submitted":text.chars().count()}),
                                        )?;
                                        write(
                                            &mut ws,
                                            frame(&o.id, "continue-task", json!({"text":text})),
                                        )?;
                                        write(&mut ws, frame(&o.id, "finish-task", json!({})))?;
                                        controller.publish(
                                            &app,
                                            &o,
                                            json!({"state":"Synthesizing"}),
                                        );
                                    }
                                    Some("task-failed") => {
                                        sink.stop();
                                        return Err(service_error(&e));
                                    }
                                    Some("task-finished") => {
                                        if first || !pcm_tail.is_empty() {
                                            return Err("服务未返回完整可播放的 PCM 音频。".into());
                                        }
                                        while !sink.empty() {
                                            if o.cancel.load(Ordering::SeqCst) {
                                                sink.stop();
                                                return Ok(());
                                            }
                                            if began.elapsed() > Duration::from_secs(150) {
                                                sink.stop();
                                                return Err("播放时间超出本轮上限。".into());
                                            }
                                            thread::sleep(Duration::from_millis(10));
                                        }
                                        return Ok(());
                                    }
                                    _ => {}
                                }
                            }
                            Err(tungstenite::Error::Io(e))
                                if matches!(
                                    e.kind(),
                                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                                ) => {}
                            Ok(Message::Close(_)) => {
                                return Err("语音连接提前关闭，未自动重连。".into())
                            }
                            Err(_) => return Err("语音连接中断，未自动重连。".into()),
                            _ => {}
                        }
                    }
                })();
                sink.stop();
                let _ = ws.close(None);

                result
            })();
            *o.sink.lock().unwrap() = None;
            controller.finish(&app, &o, result);
        });
        Ok(result)
    }
}
fn connect(
    c: &Value,
    purpose: &str,
    o: &Operation,
    speech: &Speech,
) -> Result<WebSocket<MaybeTlsStream<TcpStream>>, String> {
    if o.cancel.load(Ordering::SeqCst) {
        return Err("音频轮次已取消".into());
    }
    let url = crate::speech_config::endpoint(c)?;
    let parsed = reqwest::Url::parse(&url).map_err(|_| "语音目的地无效")?;
    let addr = (parsed.host_str().unwrap(), 443)
        .to_socket_addrs()
        .map_err(|_| "语音服务域名无法解析")?
        .next()
        .ok_or("语音服务地址不可用")?;
    let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(8))
        .map_err(|_| "语音服务连接失败，未自动重试。")?;
    tcp.set_read_timeout(Some(Duration::from_secs(8)))
        .map_err(|_| "语音连接配置失败")?;
    tcp.set_write_timeout(Some(Duration::from_secs(8)))
        .map_err(|_| "语音连接配置失败")?;
    if o.cancel.load(Ordering::SeqCst) {
        return Err("音频轮次已取消".into());
    }
    let mut req = url.into_client_request().map_err(|_| "语音请求配置失败")?;
    req.headers_mut().insert(
        "Authorization",
        format!("Bearer {}", c[purpose]["api_key"].as_str().unwrap())
            .parse()
            .map_err(|_| "Key 格式无效")?,
    );
    speech.usage(&o.id, json!({"handshake_attempted":true}))?;
    let (mut ws, _) = tungstenite::client_tls_with_config(req, tcp, None, None)
        .map_err(|_| "语音服务握手失败，请检查地域、业务空间、Key 或服务可用性。")?;
    match ws.get_mut() {
        MaybeTlsStream::Plain(t) => {
            let _ = t.set_read_timeout(Some(Duration::from_millis(40)));
        }
        MaybeTlsStream::Rustls(t) => {
            let _ = t.sock.set_read_timeout(Some(Duration::from_millis(40)));
        }
        _ => {}
    }
    Ok(ws)
}
fn run(id: &str, kind: &str, c: &Value, parameters: Value) -> Value {
    json!({"header":{"action":"run-task","task_id":id,"streaming":"duplex"},
    "payload":{"task_group":"audio","task":kind,"function":if kind=="asr"{"recognition"}else{"SpeechSynthesizer"},"model":c[kind]["model"],"parameters":parameters,"input":{}}})
}
fn frame(id: &str, action: &str, input: Value) -> Value {
    json!({"header":{"action":action,"task_id":id,"streaming":"duplex"},"payload":{"input":input}})
}
fn write(ws: &mut WebSocket<MaybeTlsStream<TcpStream>>, v: Value) -> Result<(), String> {
    ws.send(Message::Text(v.to_string().into()))
        .map_err(|_| "语音协议发送失败，未自动重试。".into())
}
fn read(ws: &mut WebSocket<MaybeTlsStream<TcpStream>>) -> Result<Option<Value>, String> {
    match ws.read() {
        Ok(Message::Text(t)) => serde_json::from_str(&t)
            .map(Some)
            .map_err(|_| "语音服务返回无效事件".into()),
        Err(tungstenite::Error::Io(e))
            if matches!(
                e.kind(),
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
            ) =>
        {
            Ok(None)
        }
        Ok(Message::Close(_)) => Err("语音连接提前结束，未自动重连。".into()),
        Err(_) => Err("语音连接中断，未自动重连。".into()),
        _ => Ok(None),
    }
}
fn service_error(e: &Value) -> String {
    format!(
        "语音服务未完成：{}。未自动重试；请检查权限、服务账户用量和设置。",
        e["header"]["error_code"].as_str().unwrap_or("task-failed")
    )
}
pub fn spoken_text(text: &str) -> String {
    let mut code = false;
    let mut lines = vec![];
    for l in text.lines() {
        if l.trim_start().starts_with("```") {
            code = !code;
            continue;
        }
        if code {
            continue;
        }
        // Keep all prose and qualifications; only visible markup/standalone URLs are omitted.
        if l.trim_start().starts_with("https://") || l.trim_start().starts_with("http://") {
            continue;
        }
        lines.push(
            l.trim_start_matches(['#', '>', ' '])
                .replace("**", "")
                .replace('`', ""),
        );
    }
    lines.join("\n")
}
fn paragraphs(text: &str) -> Vec<String> {
    let mut result = vec![];
    let mut current = vec![];
    for l in text.lines() {
        if l.trim().is_empty() {
            if !current.is_empty() {
                result.push(current.join("\n"));
                current.clear();
            }
        } else {
            current.push(l.to_string());
        }
    }
    if !current.is_empty() {
        result.push(current.join("\n"));
    }
    result
}
