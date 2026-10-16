use crate::job::ProcessJob;
use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::windows::process::CommandExt,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use tungstenite::{client::IntoClientRequest, Message};
use uuid::Uuid;
#[path = "execution_driver.rs"]
mod execution_driver;

#[derive(Clone)]
pub struct Connection {
    pub port: u16,
    pub token: String,
    pub instance: String,
}
#[derive(Clone, Serialize)]
pub struct Status {
    pub status: String,
    pub core_pid: Option<u32>,
    pub restart_count: usize,
    pub error: Option<String>,
}
pub struct Runtime {
    pub speech: Arc<crate::speech::Speech>,
    pub root: PathBuf,
    pub data: PathBuf,
    pub status: Mutex<Status>,
    pub connection: Mutex<Option<Connection>>,
    child: Mutex<Option<Child>>,
    job: ProcessJob,
    stopping: AtomicBool,
    pub frontend_count: AtomicUsize,
    pub frontend_revision: AtomicUsize,
    pub identity_views: Mutex<std::collections::BTreeMap<String, Value>>,
    pub second_instances: AtomicUsize,
    provider: Mutex<crate::provider::ProviderVault>,
    search: Mutex<crate::network::Vault>,
    tools: Arc<Mutex<crate::tools::Authority>>,
    plan_workers: Mutex<std::collections::HashSet<String>>,
}

impl Runtime {
    pub fn inspect_document_resource(&self,resource:&Value)->Result<Value,String> {
        let _tools=self.tools.lock().unwrap();
        crate::document_host::inspect_selection(&self.data,resource)
    }
    pub fn new(root: PathBuf, data: PathBuf) -> Result<Arc<Self>, String> {
        fs::create_dir_all(&data).map_err(|e| e.to_string())?;
        let provider = crate::provider::ProviderVault::load(&root, &data);
        let tools = crate::tools::Authority::load(&data)?;
        let search = crate::network::Vault::load(&root, &data)?;
        Ok(Arc::new(Self {
            speech: crate::speech::Speech::new(&root,&data),
            plan_workers: Mutex::new(std::collections::HashSet::new()),
            root,
            data,
            status: Mutex::new(Status {
                status: "Starting".into(),
                core_pid: None,
                restart_count: 0,
                error: None,
            }),
            connection: Mutex::new(None),
            child: Mutex::new(None),
            job: ProcessJob::new().map_err(|e| e.to_string())?,
            stopping: AtomicBool::new(false),
            frontend_count: AtomicUsize::new(0),
            frontend_revision: AtomicUsize::new(0),
            identity_views: Mutex::new(std::collections::BTreeMap::new()),
            second_instances: AtomicUsize::new(0),
            provider: Mutex::new(provider),
            search: Mutex::new(search),
            tools: Arc::new(Mutex::new(tools)),
        }))
    }
    fn publish(&self, app: &AppHandle, status: &str, error: Option<String>) {
        let snapshot = {
            let mut s = self.status.lock().unwrap();
            s.status = status.into();
            s.error = error;
            s.clone()
        };
        let _ = app.emit("host-status", snapshot);
    }
    fn spawn_core(&self) -> Result<Connection, String> {
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let instance = Uuid::new_v4().to_string();
        let mut child = Command::new(self.root.join(".venv/Scripts/python.exe"))
            .args(["-m", "aevora.server"])
            .current_dir(&self.root)
            .env("PYTHONPATH", self.root.join("services/agent"))
            .env("PYTHONNOUSERSITE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(
                fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(self.data.join("core.log"))
                    .map_err(|e| e.to_string())?,
            ))
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| format!("Core launch: {e}"))?;
        if let Err(e) = self.job.assign(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Job assignment: {e}"));
        }
        let mut input = child.stdin.take().unwrap();
        let output = child.stdout.take().unwrap();
        let pid = child.id();
        *self.child.lock().unwrap() = Some(child);
        self.status.lock().unwrap().core_pid = Some(pid);
        writeln!(
            input,
            "{}",
            json!({"token": token, "instance_id": instance, "data_dir": self.data,
                "provider":self.provider.lock().unwrap().config()})
        )
        .map_err(|e| e.to_string())?;
        drop(input);
        let (tx, rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(output)
                .read_line(&mut line)
                .map_err(|e| e.to_string())
                .and_then(|_| serde_json::from_str::<Value>(&line).map_err(|e| e.to_string()));
            let _ = tx.send(result);
        });
        let handshake = rx
            .recv_timeout(Duration::from_secs(15))
            .map_err(|_| "Core handshake timeout".to_string())??;
        let core_pid = handshake["pid"]
            .as_u64()
            .filter(|p| *p <= u32::MAX as u64)
            .ok_or("Invalid Core pid")? as u32;
        // Windows .venv/python.exe is a launcher: the server may run in its child.
        if handshake["protocol_version"] != 1
            || handshake["runtime_instance_id"] != instance
            || !self.job.contains_pid(core_pid)
        {
            return Err("Core handshake incompatible".into());
        }
        self.status.lock().unwrap().core_pid = Some(core_pid);
        let port = handshake["port"]
            .as_u64()
            .filter(|p| *p > 0 && *p <= 65535)
            .ok_or("Invalid port")? as u16;
        let c = Connection {
            port,
            token,
            instance,
        };
        let start = Instant::now();
        loop {
            if request(
                &c,
                &json!({"protocol_version": 1, "command_id": Uuid::new_v4().to_string(),
                "type": "GetSnapshot", "payload": {}}),
            )
            .is_ok()
            {
                return Ok(c);
            }
            if start.elapsed() > Duration::from_secs(10) {
                return Err("Core readiness timeout".into());
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    fn cleanup_child(&self) {
        crate::command_tools::cancel_all();
        {
            let mut status = self.status.lock().unwrap();
            status.status = "Offline".into();
            status.core_pid = None;
        }
        *self.connection.lock().unwrap() = None;
        self.job.terminate();
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    pub fn stop(&self) {
        self.speech.cancel(None);
        self.stopping.store(true, Ordering::SeqCst);
        let c = self.connection.lock().unwrap().clone();
        if let Some(c) = c {
            if let Ok(client) = Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(1))
                .build()
            {
                let _ = client
                    .post(format!("http://127.0.0.1:{}/shutdown", c.port))
                    .bearer_auth(&c.token)
                    .send();
            }
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(3) {
                let exited = self
                    .child
                    .lock()
                    .unwrap()
                    .as_mut()
                    .map(|child| child.try_wait().ok().flatten().is_some())
                    .unwrap_or(true);
                if exited {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        }
        self.cleanup_child();
        self.status.lock().unwrap().status = "Stopped".into();
    }

    pub fn command(&self, value: &Value) -> Result<Value, String> {
        if !value["payload"]["execution_ref"].is_null(){return Err("Execution dispatch is owned by Native Host".into());}
        if matches!(value["type"].as_str(),Some("PauseTask"|"CancelTask"|"RevokeTaskPermission")) {
            crate::command_tools::cancel(value["payload"]["task_id"].as_str().unwrap_or(""));
        }
        if matches!(value["type"].as_str(),Some("SendMessage"|"SelectAgent"|"SelectConversation"|"DeleteConversation"|"ConfigureProvider"|"EditPersona"|"EditGoal"|"ChangeGoalState"|"DeleteGoal"|"EditMemory"|"RememberInteraction"|"ForgetMemory"|"DeleteMemory")) { self.speech.cancel(None); }
        self.stop_execution_authority(value)?;
        let c = self
            .connection
            .lock()
            .unwrap()
            .clone()
            .ok_or("Core unavailable")?;
        if value["type"].as_str().map(|k| k.ends_with("GoalExecution") || k=="EditGoalExecutionPlan").unwrap_or(false) {
            return self.execution_command(&c,value);
        }
        if value["type"] == "ConfigureProvider" {
            let mut vault = self.provider.lock().unwrap();
            let command_id = value["command_id"].as_str().ok_or("command_id required")?;
            if let Some(old) = vault.value["results"].get(command_id) {
                if old["request"] != *value {
                    return Err("command_id reused with different request".into());
                }
                return Ok(old["response"].clone());
            }
            if value["expected_revision"].as_u64().unwrap_or(0)
                != vault.config()["revision"].as_u64().unwrap_or(0)
            {
                return Err(json!({"error":{"code":"RevisionConflict","message":"Provider changed; refresh settings"}}).to_string());
            }
            let config = crate::provider::validate(&value["payload"], &vault.config())?;
            configure_core(&c, &config)?;
            let response = json!({"command_id":command_id,"status":"persisted","data":crate::provider::public(&config)});
            let mut next = vault.value.clone();
            next["config"] = config;
            next["results"][command_id] = json!({"request":value,"response":response});
            if let Err(error) = crate::provider::ProviderVault::save_value(&self.data, &next) {
                let _ = configure_core(&c, &vault.config());
                return Err(error);
            }
            vault.value = next;
            vault.error = None;
            return Ok(response);
        }
        if value["type"] == "ConfigureSearch" {
            let public = self.search.lock().unwrap().configure(value)?;
            // Configuration revision changes revoke old task grants, including pending model work.
            let snapshot = request(&c,&json!({"protocol_version":1,"command_id":Uuid::new_v4().to_string(),"type":"GetSnapshot","payload":{}}))?;
            for agent in snapshot["data"]["agents"].as_array().ok_or("Agent list unavailable")? {
                let aid = agent["agent_id"].as_str().ok_or("Agent required")?;
                let tasks = request(&c,&json!({"protocol_version":1,"command_id":Uuid::new_v4().to_string(),"type":"ListTasks","agent_id":aid,"payload":{}}))?;
                for task in tasks["data"].as_array().ok_or("Task list unavailable")? {
                    if task["kind"] == "network" && task["permission"] == 1 && task["runs"][0]["context"]["search_revision"] != public["revision"] {
                        let revoke = json!({"protocol_version":1,"command_id":Uuid::new_v4().to_string(),"type":"RevokeTaskPermission","agent_id":aid,
                            "expected_revision":task["revision"],"payload":{"task_id":task["task_id"]}});
                        if self.task_command(&c,&revoke).is_err() {
                            let current = self.get_task(&c,&revoke)?;
                            let mut retry = revoke.clone();retry["command_id"] = json!(Uuid::new_v4().to_string());retry["expected_revision"] = current["revision"].clone();
                            self.task_command(&c,&retry)?;
                        }
                    }
                }
            }
            return Ok(json!({"command_id":value["command_id"],"status":"persisted","data":public}));
        }
        if value["type"] == "SendMessage" && !value["payload"]["interaction_trial"].is_null() {
            let grant = &value["payload"]["interaction_trial"];
            let provider = self.provider.lock().unwrap().config();
            if provider["chat_allowed"] != true || grant["allow_outbound"] != true
                || grant["provider"] != crate::tools::binding(&provider) {
                return Err("Confirm candidate trial for the current Provider".into());
            }
        }
        if matches!(value["type"].as_str(), Some("CreateMethodProposal" | "CreateConversationMethodProposal" | "RunInteractionComparison")) || (value["type"] == "ConfigureProactivity" && value["payload"]["think"] == true) {
            let provider = self.provider.lock().unwrap().config();
            if provider["chat_allowed"] != true || provider["api_key"].as_str().unwrap_or("").is_empty()
                || value["payload"]["provider"] != crate::tools::binding(&provider) {
                return Err("Explicit current Provider binding and purpose permission required".into());
            }
            if value["type"] != "ConfigureProactivity" && value["payload"]["allow_outbound"] != true {
                return Err("Approve learning outbound first".into());
            }
        }
        if matches!(value["type"].as_str(), Some("CreateNetworkTask" | "SelectNetworkSources" | "ApproveNetworkRedirect")) {
            return self.network_command(&c, value);
        }
        if value["type"] == "ApproveTaskPlan" {
            let task = self.get_task(&c, value)?;
            if task["kind"] == "network" { return self.network_command(&c, value); }
        }
        if matches!(
            value["type"].as_str(),
            Some(
                "CreateTask"
                    | "CreateAgentTask"
                    | "AnswerAgentTask"
                    | "ReviseAgentAction"
                    | "CreatePlannedTask"
                    | "RetryTask"
                    | "ApproveTask"
                    | "RevokeTaskPermission"
                    | "ResolveTask"
                    | "PreviewTaskArtifact"
                    | "OpenTaskArtifact"
            )
        ) {
            return self.task_command(&c, value);
        }
        let mut response = request(&c, value)?;
        if value["type"] == "GetSnapshot" {
            response["data"]["provider_store_error"] = json!(self.provider.lock().unwrap().error);
            response["data"]["search"] = self.search.lock().unwrap().public();
            response["data"]["speech"] = self.speech.public();
        }
        Ok(response)
    }
    fn get_task(&self, c: &Connection, value: &Value) -> Result<Value, String> {
        Ok(request(c, &json!({"protocol_version":1,"command_id":Uuid::new_v4().to_string(),"type":"GetTask",
            "agent_id":value["agent_id"],"payload":{"task_id":value["payload"]["task_id"]}}))?["data"].clone())
    }
    fn network_command(&self, c: &Connection, value: &Value) -> Result<Value, String> {
        let provider = self.provider.lock().unwrap().config();
        let search = self.search.lock().unwrap().clone();
        let public = search.public();
        if value["type"] == "CreateNetworkTask" {
            search.check(&public["revision"])?;
            let normalized = self.tools.lock().unwrap().create_network(value, &provider, &public)?;
            let response = request(c, &normalized)?;
            if response["data"]["state"] != "Created" { return Ok(response); }
            return native_task(c, "task-input", &json!({"agent_id":value["agent_id"],"task_id":value["command_id"],
                "provider":crate::tools::binding(&provider),"search_revision":public["revision"]}));
        }
        let task = self.get_task(c, value)?;
        self.tools.lock().unwrap().outbound(task["agent_id"].as_str().ok_or("Agent required")?,task["task_id"].as_str().ok_or("Task required")?, &provider)?;
        search.check(&task["runs"][0]["context"]["search_revision"])?;
        self.tools.lock().unwrap().review_network(&task, value)?;
        request(c, value)
    }
    fn task_command(&self, c: &Connection, value: &Value) -> Result<Value, String> {
        let kind = value["type"].as_str().unwrap();
        let aid = value["agent_id"].as_str().ok_or("Agent required")?;
        let tid = if kind == "CreateTask" || kind == "CreatePlannedTask" || kind == "CreateAgentTask" {
            value["command_id"].as_str()
        } else {
            value["payload"]["task_id"].as_str()
        }
        .ok_or("Task required")?;
        let get = || {
            request(
                c,
                &json!({"protocol_version":1,"command_id":Uuid::new_v4().to_string(),"type":"GetTask","agent_id":aid,"payload":{"task_id":tid}}),
            )
        };
        // Serializes native grants/writes/revocation, never holds a lock while the model runs.
        let mut tools = self.tools.lock().unwrap();
        if kind=="CreateAgentTask" {
            let provider=self.provider.lock().unwrap().config();
            let search=self.search.lock().unwrap().clone();
            if value["payload"]["allow_search"]==true {search.check(&search.public()["revision"])?;}
            let normalized=tools.create_agent(value,&provider,&search.public())?;
            let response=request(c,&normalized)?;
            if response["data"]["state"]!="Created" {return Ok(response);}
            return native_task(c,"task-input",&json!({"agent_id":aid,"task_id":tid,"provider":crate::tools::binding(&provider),"search_revision":search.public()["revision"]}));
        }
        if matches!(kind,"AnswerAgentTask"|"ReviseAgentAction") {
            let provider=self.provider.lock().unwrap().config();
            tools.outbound(aid,tid,&provider)?;
            return request(c,value);
        }
        if kind == "CreateTask" || kind == "CreatePlannedTask" || kind == "RetryTask" {
            let provider = self.provider.lock().unwrap().config();
            if kind == "CreateTask" || kind == "CreatePlannedTask" {
                let normalized = tools.create(value, &provider)?;
                request(c, &normalized)?;
            } else {
                let task = get()?["data"].clone();
                tools.outbound(aid, tid, &provider)?;
                if task["kind"] == "network" {
                    self.search.lock().unwrap().check(&task["runs"][0]["context"]["search_revision"])?;
                }
                request(c, value)?;
            }
            let mut response = get()?;
            if response["data"]["state"] != "Created" {
                return Ok(response);
            }
            if response["data"]["kind"] == "network" {
                return native_task(c, "task-input", &json!({"agent_id":aid,"task_id":tid,"provider":crate::tools::binding(&provider),
                    "search_revision":self.search.lock().unwrap().public()["revision"]}));
            }
            if response["data"]["kind"]=="agent" {return native_task(c,"task-input",&json!({"agent_id":aid,"task_id":tid,"provider":crate::tools::binding(&provider),"search_revision":self.search.lock().unwrap().public()["revision"]}));}
            let input = match tools.files(aid, tid, &provider) {
                Ok(files) => {
                    json!({"agent_id":aid,"task_id":tid,"files":files,"provider":crate::tools::binding(&provider)})
                }
                Err(_) => {
                    json!({"agent_id":aid,"task_id":tid,"error":"FileReadOrPermissionFailed"})
                }
            };
            response = match native_task(c, "task-input", &input) {
                Ok(v) => v,
                Err(error) => {
                    let _ = native_task(
                        c,
                        "task-input",
                        &json!({"agent_id":aid,"task_id":tid,"error":"FileInputRejected"}),
                    );
                    return Err(error);
                }
            };
            return Ok(response);
        }
        let task = get()?["data"].clone();
        if matches!(kind,"OpenTaskArtifact"|"PreviewTaskArtifact") && value["payload"]["output_id"].as_str().unwrap_or("").starts_with("tool") {
            return Ok(json!({"status":"persisted","data":tools.preview_general(&task,value["payload"]["output_id"].as_str().unwrap(),kind=="OpenTaskArtifact")?}));
        }
        if kind=="OpenTaskArtifact" {
            let id=value["payload"]["output_id"].as_str().ok_or("DocumentReferenceRequired")?;
            return Ok(json!({"status":"persisted","data":tools.open_saved_document(&task,id)?}));
        }
        if kind == "ApproveTask" && task["kind"] == "network" {
            self.search.lock().unwrap().check(&task["runs"][0]["context"]["search_revision"])?;
        }
        if kind == "PreviewTaskArtifact" {
            if let Some(id)=value["payload"]["output_id"].as_str().filter(|s|s.starts_with("document")) {
                return Ok(json!({"status":"persisted","data":tools.preview_document(&task,id)?}));
            }
            let view = if task["kind"] == "plan" || task["kind"] == "network" || task["kind"] == "agent" {
                crate::planned_host::artifact_view(&task, &value["payload"]["output_id"])?
            } else {
                task.clone()
            };
            return Ok(json!({"status":"persisted","data":tools.preview(&view)?}));
        }
        if task["revision"] != value["expected_revision"] {
            return Err(json!({"error":{"code":"RevisionConflict","message":"Task changed; review the current proposal"}}).to_string());
        }
        if kind == "RevokeTaskPermission" {
            // Revoke native authority first: a Core persistence failure must not leave file access enabled.
            tools.revoke(aid, tid)?;
            return request(c, value);
        }
        if kind == "ResolveTask" {
            if task["state"] != "NeedsAttention" && task["state"] != "Executing" {
                return Err("No uncertain write to reconcile".into());
            }
            if crate::general_host::WRITES.contains(&task["current_step"]["definition"]["op"].as_str().unwrap_or("")) {
                let receipt=tools.resolve_general(&task)?;
                return native_task(c,"task-receipt",&json!({"agent_id":aid,"task_id":tid,"action_id":task["current_step"]["action_id"],"receipt":receipt}));
            }
            if matches!(task["current_step"]["definition"]["op"].as_str(),Some("office_propose"|"text_propose")) {
                let receipt=tools.resolve_document(&task)?;
                return native_task(c,"task-receipt",&json!({"agent_id":aid,"task_id":tid,"action_id":task["current_step"]["action"]["action_id"],"receipt":receipt}));
            }
            let view = if task["kind"] == "plan" || task["kind"] == "network" || task["kind"] == "agent" {
                crate::planned_host::action_view(&task)?
            } else {
                task.clone()
            };
            let receipt = tools.resolve(&view)?;
            return native_task(
                c,
                "task-receipt",
                &json!({"agent_id":aid,"task_id":tid,"action_id":task["runs"][0]["action"]["action_id"],"receipt":receipt}),
            );
        }
        let approved = request(c, value)?["data"].clone();
        if crate::general_host::WRITES.contains(&approved["current_step"]["definition"]["op"].as_str().unwrap_or("")) {
            let action=approved["current_step"]["action_id"].clone();
            let stage=match tools.begin_general(&approved,&self.root) {Ok(v)=>v,Err(error)=>return native_task(c,"task-receipt",&json!({"agent_id":aid,"task_id":tid,"action_id":action,"receipt":{"outcome":"NotExecuted","error":error}}))};
            drop(tools);
            if stage["definition"]["op"]=="run_command" {
                let authority=self.tools.clone();let connection=c.clone();let agent=aid.to_owned();let task_id=tid.to_owned();
                thread::spawn(move||{
                    let receipt=crate::general_host::perform(&stage);
                    if authority.lock().unwrap().finish_general(&stage,&receipt).is_ok() {
                        let _=native_task(&connection,"task-receipt",&json!({"agent_id":agent,"task_id":task_id,"action_id":action,"receipt":receipt}));
                    }
                });
                return Ok(json!({"status":"persisted","data":approved}));
            }
            let receipt=crate::general_host::perform(&stage);
            self.tools.lock().unwrap().finish_general(&stage,&receipt)?;
            return native_task(c,"task-receipt",&json!({"agent_id":aid,"task_id":tid,"action_id":action,"receipt":receipt}));
        }
        if matches!(approved["current_step"]["definition"]["op"].as_str(),Some("office_propose"|"text_propose")) {
            let receipt=tools.execute_document(&approved).unwrap_or(json!({"outcome":"Unknown","error":"NativeDocumentWriteUnconfirmed"}));
            return native_task(c,"task-receipt",&json!({"agent_id":aid,"task_id":tid,"action_id":approved["current_step"]["action"]["action_id"],"receipt":receipt}));
        }
        let approved = if approved["kind"] == "plan" || approved["kind"] == "network" || approved["kind"] == "agent" {
            crate::planned_host::action_view(&approved)?
        } else {
            approved
        };
        let receipt = tools
            .execute(&approved)
            .unwrap_or(json!({"outcome":"Unknown","error":"NativeWriteUnconfirmed"}));
        native_task(
            c,
            "task-receipt",
            &json!({"agent_id":aid,"task_id":tid,"action_id":approved["runs"][0]["action"]["action_id"],"receipt":receipt}),
        )
    }
    fn start_plan_worker(self: &Arc<Self>, c: Connection, aid: String, tid: String) {
        if !self.plan_workers.lock().unwrap().insert(tid.clone()) {
            return;
        }
        let runtime = self.clone();
        thread::spawn(move || {
            let mut recheck_waiting_transition=false;
            loop {
                if runtime.stopping.load(Ordering::SeqCst)
                    || runtime
                        .connection
                        .lock()
                        .unwrap()
                        .as_ref()
                        .map(|x| &x.instance)
                        != Some(&c.instance)
                {
                    break;
                }
                let task = match request(
                    &c,
                    &json!({"protocol_version":1,"command_id":Uuid::new_v4().to_string(),"type":"GetTask","agent_id":aid,"payload":{"task_id":tid}}),
                ) {
                    Ok(v) => v["data"].clone(),
                    Err(_) => break,
                };
                if task["kind"] != "plan" && task["kind"] != "network" && task["kind"] != "agent" {
                    break;
                }
                if task["state"] == "Generating" {
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
                if task["state"] != "Running" {
                    recheck_waiting_transition=true;
                    break;
                }
                let provider = runtime.provider.lock().unwrap().config();
                let op = task["current_step"]["definition"]["op"].as_str().unwrap_or("");
                if (task["kind"] == "network" || task["kind"] == "agent") && matches!(op, "search" | "read_web") {
                    if runtime.network_step(&c, &task, &provider).is_err() { break; }
                    continue;
                }
                if task["kind"]=="agent" && crate::general_host::is_tool(op) {
                    let start=Instant::now();
                    let result=runtime.tools.lock().unwrap().general_step(&task,&provider,&runtime.root);
                    let auto=result.as_ref().map(|v|v["auto_execute"]==true).unwrap_or(false);
                    let input=match result {Ok(mut tool)=>{tool["elapsed_ms"]=json!(start.elapsed().as_millis() as u64);json!({"agent_id":aid,"task_id":tid,"step_id":task["current_step"]["step_id"],"provider":crate::tools::binding(&provider),"tool":tool})},Err(error)=>json!({"agent_id":aid,"task_id":tid,"step_id":task["current_step"]["step_id"],"error":error})};
                    match native_task(&c,"task-input",&input){Ok(observed)=>{
                        if auto && observed["data"]["state"]=="AwaitingApproval" {
                            let approval=json!({"protocol_version":1,"command_id":Uuid::new_v4().to_string(),"type":"ApproveTask","agent_id":aid,"expected_revision":observed["data"]["revision"],"payload":{"task_id":tid}});
                            if runtime.task_command(&c,&approval).is_err(){break;}
                        }
                    },Err(_)=>break}
                    continue;
                }
                if task["kind"]=="agent"&&matches!(op,"office_inspect"|"office_read"|"office_calculate"|"office_propose"|"text_propose") {
                    let result=runtime.tools.lock().unwrap().document_step(&task,&provider);
                    let input=match result {Ok(document)=>json!({"agent_id":aid,"task_id":tid,"step_id":task["current_step"]["step_id"],"provider":crate::tools::binding(&provider),"document":document}),Err(error)=>json!({"agent_id":aid,"task_id":tid,"step_id":task["current_step"]["step_id"],"error":error})};
                    if native_task(&c,"task-input",&input).is_err(){break;}
                    continue;
                }
                if op != "read" { break; }
                let file = runtime.tools.lock().unwrap().read_step(&task, &provider);
                let input = match file {
                    Ok(file) => {
                        json!({"agent_id":aid,"task_id":tid,"step_id":task["current_step"]["step_id"],"provider":crate::tools::binding(&provider),"file":file})
                    }
                    Err(error) => {
                        json!({"agent_id":aid,"task_id":tid,"step_id":task["current_step"]["step_id"],"error":if error=="ArtifactChanged" {"ArtifactChanged"} else {"FileReadOrPermissionFailed"}})
                    }
                };
                if native_task(&c, "task-input", &input).is_err() {
                    break;
                }
            }
            runtime.plan_workers.lock().unwrap().remove(&tid);
            // A user answer/approval can arrive just as the worker observes a waiting state.
            // Recheck after releasing its slot so that event cannot leave new work unattended.
            if recheck_waiting_transition&&!runtime.stopping.load(Ordering::SeqCst) {
                if let Ok(latest)=request(&c,&json!({"protocol_version":1,"command_id":Uuid::new_v4().to_string(),"type":"GetTask","agent_id":aid,"payload":{"task_id":tid}})) {
                    if latest["data"]["state"]=="Running" && latest["data"]["kind"]=="agent" {
                        runtime.start_plan_worker(c,aid,tid);
                    }
                }
            }
        });
    }

    fn network_step(&self, c: &Connection, task: &Value, provider: &Value) -> Result<(), String> {
        let aid = &task["agent_id"]; let tid = &task["task_id"];
        let id = Uuid::new_v4().to_string();
        let search = self.search.lock().unwrap().clone();
        let direct=task["kind"]=="agent" && task["agent_limits"]["tools"]["urls"].as_array().map(|v|v.contains(&task["current_step"]["definition"]["url"])).unwrap_or(false) && task["current_step"]["definition"]["op"]=="read_web";
        let authorized = (if direct {Ok(())} else {search.check(&task["runs"][0]["context"]["search_revision"])})
            .and_then(|_| self.tools.lock().unwrap().begin_network(task, provider, &search.public(), &id));
        let hosts = match authorized {
            Ok(hosts) => hosts,
            Err(error) => {
                let code = if error == "SearchRequestLimit" { "SearchRequestLimit" } else { "NetworkPermissionChanged" };
                native_task(c,"task-input",&json!({"agent_id":aid,"task_id":tid,"error":code}))?; return if task["kind"]=="agent" {Ok(())} else {Err(code.into())};
            }
        };
        let step = &task["current_step"];
        native_task(c,"task-input",&json!({"agent_id":aid,"task_id":tid,"phase":"start","request_id":id,"step_id":step["step_id"]}))?;
        // Release authority/configuration locks before HTTP so user revocation remains responsive.
        let start = Instant::now();
        let result = if step["definition"]["op"] == "search" {
            search.search(step["definition"]["query"].as_str().ok_or("Query required")?, &task["runs"][0]["context"]["search_revision"])
        } else { crate::network::fetch(step["definition"]["url"].as_str().ok_or("URL required")?, &hosts) };
        let mut input = json!({"agent_id":aid,"task_id":tid,"phase":"result","request_id":id,
            "metadata":{"elapsed_ms":start.elapsed().as_millis() as u64,"attempt_started":true}});
        match result {
            Ok(result) => { input["metadata"]["usage"] = result["usage"].clone(); input["metadata"]["service_request_id"] = result["request_id"].clone();
                input["metadata"]["http_requests_started"] = result["http_requests_started"].clone(); input["result"] = result; }
            Err(error) => input["error"] = json!(error),
        }

        // A purpose/config change while HTTP was in flight retains counts but discards bodies.
        if (!direct && self.search.lock().unwrap().check(&task["runs"][0]["context"]["search_revision"]).is_err())
            || self.tools.lock().unwrap().outbound(aid.as_str().unwrap(),tid.as_str().unwrap(),&self.provider.lock().unwrap().config()).is_err() {
            input["result"] = json!({}); input["error"] = json!("NetworkPermissionChanged");
        }
        if task["kind"]=="agent" {self.tools.lock().unwrap().finish_agent_network(&id,&input["metadata"],&input["result"])?;} else {self.tools.lock().unwrap().finish_network(&id, &input["metadata"])?;}
        native_task(c,"task-input",&input)?;
        Ok(())
    }
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        let runtime = self.clone();
        self.start_events(app.clone());
        thread::spawn(move || {
            let mut starts = 0;
            while !runtime.stopping.load(Ordering::SeqCst) {
                runtime.publish(
                    &app,
                    if starts == 0 {
                        "Starting"
                    } else {
                        "Recovering"
                    },
                    None,
                );
                runtime.status.lock().unwrap().restart_count = starts;
                match runtime.spawn_core() {
                    Ok(c) => {
                        if runtime.stopping.load(Ordering::SeqCst) {
                            runtime.cleanup_child();
                            break;
                        }
                        *runtime.connection.lock().unwrap() = Some(c);
                        runtime.publish(&app, "Ready", None);
                    }
                    Err(e) => {
                        runtime.cleanup_child();
                        runtime.publish(&app, "Offline", Some(e));
                    }
                }
                let connected = runtime.connection.lock().unwrap().is_some();
                if connected {
                    loop {
                        if runtime.stopping.load(Ordering::SeqCst) {
                            break;
                        }
                        let exited = runtime
                            .child
                            .lock()
                            .unwrap()
                            .as_mut()
                            .map(|c| c.try_wait().map(|s| s.is_some()).unwrap_or(true))
                            .unwrap_or(true);
                        if exited {
                            break;
                        }
                        thread::sleep(Duration::from_millis(200));
                    }
                }
                if runtime.stopping.load(Ordering::SeqCst) {
                    break;
                }
                runtime.cleanup_child();
                if starts >= 3 {
                    runtime.publish(
                        &app,
                        "Offline",
                        Some("Core restart limit reached; restart Aevora to retry".into()),
                    );
                    break;
                }
                starts += 1;
                thread::sleep(Duration::from_millis(500));
            }
        });
    }
    fn start_events(self: &Arc<Self>, app: AppHandle) {
        let runtime = self.clone();
        thread::spawn(move || {
            let mut after = 0;
            while !runtime.stopping.load(Ordering::SeqCst) {
                let c = runtime.connection.lock().unwrap().clone();
                let Some(c) = c else {
                    thread::sleep(Duration::from_millis(300));
                    continue;
                };
                let mut request =
                    format!("ws://127.0.0.1:{}/events?after_sequence={after}", c.port)
                        .into_client_request()
                        .unwrap();
                request.headers_mut().insert(
                    "Authorization",
                    format!("Bearer {}", c.token).parse().unwrap(),
                );
                if let Ok((mut socket, _)) = tungstenite::connect(request) {
                    let mut execution_checked=Instant::now()-Duration::from_secs(2);
                    if let tungstenite::stream::MaybeTlsStream::Plain(tcp) = socket.get_mut() {
                        let _ = tcp.set_read_timeout(Some(Duration::from_millis(500)));
                    }
                    loop {
                        if runtime.stopping.load(Ordering::SeqCst) {
                            break;
                        }
                        if execution_checked.elapsed()>=Duration::from_secs(1) {
                            let _=runtime.execution_tick(&c);
                            execution_checked=Instant::now();
                        }
                        if runtime
                            .connection
                            .lock()
                            .unwrap()
                            .as_ref()
                            .map(|x| &x.instance)
                            != Some(&c.instance)
                        {
                            break;
                        }
                        match socket.read() {
                            Ok(Message::Text(text)) => {
                                if let Ok(event) = serde_json::from_str::<Value>(&text) {
                                    if event["type"] == "TaskRunning" {
                                        if let (Some(aid), Some(tid)) = (
                                            event["agent_id"].as_str(),
                                            event["payload"]["task_id"].as_str(),
                                        ) {
                                            runtime.start_plan_worker(
                                                c.clone(),
                                                aid.to_string(),
                                                tid.to_string(),
                                            );
                                        }
                                    }
                                    if let Some(seq) = event["sequence"].as_u64() {
                                        after = seq;
                                    }
                                    if !event["type"].as_str().unwrap_or("").ends_with("Delta") {
                                        runtime.speech.validate_context(&runtime);
                                    }
                                    let _ = app.emit("runtime-event", event);
                                }
                            }
                            Err(tungstenite::Error::Io(e))
                                if matches!(
                                    e.kind(),
                                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                                ) => {}
                            Err(_) | Ok(Message::Close(_)) => break,
                            _ => {}
                        }
                    }
                    let _ = socket.close(None);
                }
                thread::sleep(Duration::from_millis(300));
            }
        });
    }
}
fn configure_core(c: &Connection, config: &Value) -> Result<(), String> {
    let response = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| "Core client unavailable")?
        .post(format!("http://127.0.0.1:{}/provider", c.port))
        .bearer_auth(&c.token)
        .json(config)
        .send()
        .map_err(|_| "Core configuration unavailable")?;
    if !response.status().is_success() {
        return Err(response
            .text()
            .unwrap_or_else(|_| "Core rejected Provider configuration".into()));
    }
    Ok(())
}
pub fn native_task(c: &Connection, route: &str, value: &Value) -> Result<Value, String> {
    let response = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| "Core client unavailable")?
        .post(format!("http://127.0.0.1:{}/{route}", c.port))
        .bearer_auth(&c.token)
        .json(value)
        .send()
        .map_err(|_| "Native task receipt connection unavailable")?;
    let status = response.status();
    let result: Value = response
        .json()
        .map_err(|_| "Invalid native task response")?;
    if !status.is_success() {
        return Err(result.to_string());
    }
    if result["protocol_version"] != 1 || result["runtime_instance_id"] != c.instance {
        return Err("Core task protocol mismatch".into());
    }
    Ok(result)
}
pub fn request(c: &Connection, command: &Value) -> Result<Value, String> {
    let response = Client::builder()
        .timeout(Duration::from_secs(
            if command["type"] == "SearchMemories" {
                125
            } else {
                5
            },
        ))
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?
        .post(format!("http://127.0.0.1:{}/command", c.port))
        .bearer_auth(&c.token)
        .json(command)
        .send()
        .map_err(|_| "Core connection unavailable".to_string())?;
    let status = response.status();
    let value: Value = response
        .json()
        .map_err(|_| "Invalid Core response".to_string())?;
    if !status.is_success() {
        return Err(value.to_string());
    }
    if value["protocol_version"] != 1 || value["runtime_instance_id"] != c.instance {
        return Err("Core protocol mismatch".into());
    }
    Ok(value)
}
