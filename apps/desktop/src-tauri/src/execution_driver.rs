//! Called from the existing Host event lifecycle, including startup/idle synchronization.
use super::*;

impl Runtime {
    pub(super) fn execution_command(&self, c: &Connection, value: &Value) -> Result<Value, String> {
        let kind = value["type"].as_str().ok_or("CommandRequired")?;
        if kind == "CreateGoalExecution" {
            let provider = self.provider.lock().unwrap().config();
            let normalized = self
                .tools
                .lock()
                .unwrap()
                .create_execution(value, &provider)?;
            return request(c, &normalized);
        }
        if kind == "GetGoalExecution" {
            let mut response = request(c, value)?;
            if let Some(eid) = response["data"]["execution_id"].as_str().map(str::to_owned) {
                response["data"]["budget"] = self.tools.lock().unwrap().execution_budget(&eid);
            }
            return Ok(response);
        }
        let eid = value["payload"]["execution_id"]
            .as_str()
            .ok_or("ExecutionRequired")?;
        if kind == "RenewGoalExecution" {
            let provider = self.provider.lock().unwrap().config();
            let old = self.tools.lock().unwrap().value["executions"][eid].clone();
            if old["state"] == "Revoked" {
                return Err("ExecutionRevoked".into());
            }
            let renewed = crate::execution_host::reviewed_execution(value, &provider)?;
            let response = request(c, value)?;
            let mut tools = self.tools.lock().unwrap();
            let mut next = tools.value.clone();
            for tid in old["tasks"]
                .as_object()
                .ok_or("ExecutionTasksRequired")?
                .keys()
            {
                next["grants"][tid]["enabled"] = json!(false);
            }
            for key in ["scope", "provider", "snapshot"] {
                next["executions"][eid][key] = renewed[key].clone();
            }
            next["executions"][eid]["state"] = json!("Planning");
            next["executions"][eid]["conditions"] = json!({});
            next["executions"][eid]["last_renewal"] = value.clone();
            tools.save(next)?;
            return Ok(response);
        }
        if matches!(kind, "PauseGoalExecution" | "RevokeGoalExecution") {
            self.tools.lock().unwrap().execution_state(
                eid,
                if kind == "RevokeGoalExecution" {
                    "Revoked"
                } else {
                    "Paused"
                },
            )?;
            self.cancel_execution_children(eid);
        }
        if matches!(kind, "ApproveGoalExecution" | "ResumeGoalExecution") {
            let grant = self.tools.lock().unwrap().value["executions"][eid].clone();
            let mut proposed = grant.clone();
            proposed["state"] = json!("Active");
            crate::execution_host::valid_time(&proposed)?;
            if proposed["provider"]
                != crate::tools::binding(&self.provider.lock().unwrap().config())
            {
                return Err("ExecutionProviderChanged".into());
            }
        }
        let response = request(c, value)?;
        if matches!(kind, "ApproveGoalExecution" | "ResumeGoalExecution") {
            self.tools.lock().unwrap().execution_state(
                eid,
                if response["data"]["state"] == "Planning" {
                    "Planning"
                } else {
                    "Active"
                },
            )?;
            // Establish changed-file baselines when the user approves the plan.
            if let Some(ns) = response["data"]["nodes"].as_array() {
                for node in ns {
                    if node["condition"]["mode"] == "changed" {
                        self.tools.lock().unwrap().execution_condition(eid, node)?;
                    }
                }
            }
        }
        Ok(response)
    }
    fn cancel_execution_children(&self, eid: &str) {
        let tasks = self.tools.lock().unwrap().value["executions"][eid]["tasks"].clone();
        if let Some(tasks) = tasks.as_object() {
            for tid in tasks.keys() {
                crate::command_tools::cancel(tid);
            }
        }
    }
    pub(super) fn stop_execution_authority(&self, value: &Value) -> Result<(), String> {
        let kind = value["type"].as_str().unwrap_or("");
        let all = kind == "Pause";
        let goal = matches!(kind, "ChangeGoalState" | "DeleteGoal" | "EditGoal");
        let scheduler = kind == "ConfigureScheduler" && value["payload"]["enabled"] == false;
        let child = (kind == "SaveTaskFeedback" && value["payload"]["quality"] == "NeedsRevision")
            || matches!(
                kind,
                "PauseTask" | "CancelTask" | "RejectTask" | "RevokeTaskPermission"
            );
        if !(all || goal || scheduler || child) {
            return Ok(());
        }
        let mut tools = self.tools.lock().unwrap();
        let child_parent = tools.value["grants"]
            [value["payload"]["task_id"].as_str().unwrap_or("")]["execution_id"]
            .as_str()
            .map(str::to_owned);
        let ids: Vec<_> = tools.value["executions"]
            .as_object()
            .map(|m| {
                m.iter()
                    .filter(|(_, p)| {
                        p["state"] != "Revoked"
                            && (all
                                || p["agent_id"] == value["agent_id"]
                                    && (scheduler
                                        || goal && p["goal_id"] == value["payload"]["goal_id"]
                                        || child
                                            && child_parent.as_deref()
                                                == p["request"]["command_id"].as_str()))
                    })
                    .map(|(id, _)| id.clone())
                    .collect()
            })
            .unwrap_or_default();
        for id in &ids {
            tools.execution_state(id, "Paused")?;
        }
        drop(tools);
        for id in ids {
            self.cancel_execution_children(&id);
        }
        Ok(())
    }
    pub(super) fn execution_tick(self: &Arc<Self>, c: &Connection) -> Result<(), String> {
        let entries = native_task(c, "execution-native", &json!({"op":"sync"}))?;
        let provider = self.provider.lock().unwrap().config();
        for e in entries["data"]
            .as_array()
            .ok_or("ExecutionSnapshotRequired")?
        {
            let eid = e["execution_id"].as_str().ok_or("ExecutionRequired")?;
            let aid = e["agent_id"].as_str().ok_or("AgentRequired")?;
            let owned = self.tools.lock().unwrap().value["executions"][eid].clone();
            if owned.is_null()
                || owned["agent_id"] != e["agent_id"]
                || owned["goal_id"] != e["goal_id"]
            {
                continue;
            }
            let host_scope = &owned["scope"];
            // Mirror explicit erasure of model-derived child instructions in the saved
            // authorization request. Native receipts and budget ledgers remain intact.
            {
                let mut tools = self.tools.lock().unwrap();
                let mut erase_ids = Vec::new();
                for node in e["nodes"].as_array().ok_or("NodesRequired")? {
                    if node["context_erased"] == true {
                        if let Some(tid) = node["task_id"].as_str() {
                            if tools.value["grants"][tid].is_object() && tools.value["grants"][tid]["command"]["payload"]["instruction"] != "" {
                                erase_ids.push(tid);
                            }
                        }
                    }
                }
                if !erase_ids.is_empty() {
                    let mut next = tools.value.clone();
                    for tid in erase_ids {
                        next["grants"][tid]["command"]["payload"]["instruction"] = json!("");
                        next["grants"][tid]["command"]["payload"]["title"] = json!("已清除依赖内容");
                    }
                    tools.save(next)?;
                }
            }
            let mut can_start = matches!(
                e["state"].as_str(),
                Some("Running" | "Waiting" | "Planning")
            );
            if can_start {
                let permission = self.tools.lock().unwrap().execution(eid).map(|_| ());
                if let Err(reason) = permission {
                    self.tools.lock().unwrap().execution_state(eid, "Paused")?;
                    self.cancel_execution_children(eid);
                    native_task(
                        c,
                        "execution-native",
                        &json!({"op":"stop","execution_id":eid,"agent_id":aid,"reason":reason}),
                    )?;
                    can_start = false;
                }
            }
            if matches!(
                e["state"].as_str(),
                Some("Paused" | "NeedsAttention" | "Completed" | "Revoked")
            ) {
                let mut tools = self.tools.lock().unwrap();
                if !tools.value["executions"][eid].is_null() {
                    tools.execution_state(
                        eid,
                        if e["state"] == "Completed" {
                            "Completed"
                        } else if e["state"] == "Revoked" {
                            "Revoked"
                        } else {
                            "Paused"
                        },
                    )?;
                }
                drop(tools);
                self.cancel_execution_children(eid);
            }
            for w in e["work"].as_array().ok_or("ExecutionWorkRequired")? {
                let id = w["work_id"].as_str().ok_or("WorkRequired")?;
                if w["state"] == "Done" {
                    self.tools
                        .lock()
                        .unwrap()
                        .settle_execution_model(eid, id, &w["result"])?;
                    native_task(
                        c,
                        "execution-native",
                        &json!({"op":"settled","work_id":id,"agent_id":aid}),
                    )?;
                    continue;
                }
                if w["state"] != "Pending" || !can_start {
                    continue;
                }
                let result = (|| -> Result<(), String> {
                    self.tools.lock().unwrap().execution(eid)?;
                    match w["kind"].as_str() {
                        Some("Resume") => {
                            let tid = w["data"]["task_id"].as_str().ok_or("TaskRequired")?;
                            let task = request(
                                c,
                                &json!({"protocol_version":1,"command_id":Uuid::new_v4().to_string(),"type":"GetTask","agent_id":aid,"payload":{"task_id":tid}}),
                            )?;
                            if task["data"]["state"] == "Created" {
                                native_task(
                                    c,
                                    "task-input",
                                    &json!({"agent_id":aid,"task_id":tid,"provider":crate::tools::binding(&provider),"search_revision":self.search.lock().unwrap().public()["revision"]}),
                                )?;
                            } else if matches!(
                                task["data"]["state"].as_str(),
                                Some("Paused" | "Failed" | "NotExecuted")
                            ) {
                                let cmd = json!({"protocol_version":1,"command_id":id,"type":"RetryTask","agent_id":aid,"expected_revision":task["data"]["revision"],"payload":{"task_id":tid,"acknowledge_network_retry":w["data"]["acknowledge_network_retry"].as_bool().unwrap_or(false)}});
                                self.task_command(c, &cmd)?;
                            }
                            native_task(
                                c,
                                "execution-native",
                                &json!({"op":"resumed","work_id":id,"agent_id":aid}),
                            )?;
                            self.start_plan_worker(c.clone(), aid.into(), tid.into());
                        }
                        Some("Plan" | "Model") => {
                            self.tools
                                .lock()
                                .unwrap()
                                .reserve_execution_model(eid, id, &provider)?;
                            native_task(
                                c,
                                "execution-native",
                                &json!({"op":"granted","work_id":id,"agent_id":aid,"provider":crate::tools::binding(&provider),"expires_at":host_scope["expires_at"]}),
                            )?;
                        }
                        Some("Dispatch") => {
                            if e["check_due"] == false {
                                return Ok(());
                            }
                            let node = e["nodes"]
                                .as_array()
                                .and_then(|ns| ns.iter().find(|n| n["id"] == w["data"]["node_id"]))
                                .ok_or("NodeRequired")?;
                            if !self.tools.lock().unwrap().execution_condition(eid, node)? {
                                native_task(
                                    c,
                                    "execution-native",
                                    &json!({"op":"waiting","work_id":id,"agent_id":aid,"reason":"Waiting for the selected file condition"}),
                                )?;
                                return Ok(());
                            }
                            // Recheck dependency products now; an old receipt is not current file availability.
                            for dep in node["depends_on"]
                                .as_array()
                                .ok_or("DependenciesRequired")?
                            {
                                let prior = e["nodes"]
                                    .as_array()
                                    .unwrap()
                                    .iter()
                                    .find(|n| n["id"] == *dep)
                                    .ok_or("DependencyRequired")?;
                                for p in prior["products"].as_array().ok_or("ProductsRequired")? {
                                    let path = crate::general_host::resolve(
                                        &host_scope["tools"],
                                        p["root"].as_str().ok_or("RootRequired")?,
                                        p["path"].as_str().ok_or("PathRequired")?,
                                        false,
                                    )?;
                                    if json!(crate::document_resources::digest(
                                        &crate::general_host::bytes(&path, 8 * 1024 * 1024)?
                                    )) != p["version"]
                                    {
                                        return Err("DependencyArtifactChanged".into());
                                    }
                                }
                            }
                            let goal = request(
                                c,
                                &json!({"protocol_version":1,"command_id":Uuid::new_v4().to_string(),"type":"GetGoal","agent_id":aid,"payload":{"goal_id":e["goal_id"]}}),
                            )?;
                            let tid = w["data"]["task_id"].as_str().ok_or("TaskRequired")?;
                            let scope = host_scope;
                            let mut cmd = json!({"protocol_version":1,"command_id":tid,"type":"CreateAgentTask","agent_id":aid,"payload":{
                                "execution_ref":{"execution_id":eid,"dispatch_id":id,"node_id":node["id"]},"title":node["title"],"instruction":node["instruction"],"sources":[],"outputs":[],"provider":scope["provider"],"allow_file_outbound":true,
                                "allow_search":scope["allow_search"],"allow_memory":scope["allow_memory"],"max_decisions":scope["max_decisions"],"tools":scope["tools"],"goal_id":e["goal_id"],"goal_revision":goal["data"]["revision"]}});
                            if let Some(method) = scope.get("method_ref") {
                                cmd["payload"]["method_ref"] = method.clone();
                            }
                            if let Some(cid) = e["return_conversation_id"].as_str() {
                                cmd["payload"]["conversation_id"] = json!(cid);
                            }
                            let normalized = {
                                let mut tools = self.tools.lock().unwrap();
                                let search = self.search.lock().unwrap().public();
                                let normalized = if !tools.value["grants"][tid].is_null() {
                                    tools.value["grants"][tid]["command"].clone()
                                } else {
                                    tools.create_agent(&cmd, &provider, &search)?
                                };
                                tools.execution_child(eid, tid)?;
                                normalized
                            };
                            // If creation succeeded before a lost ack, use the existing task; don't change the saved request revision.
                            let found = request(
                                c,
                                &json!({"protocol_version":1,"command_id":Uuid::new_v4().to_string(),"type":"GetTask","agent_id":aid,"payload":{"task_id":tid}}),
                            );
                            if found.is_err() {
                                request(c, &normalized)?;
                            }
                            native_task(
                                c,
                                "execution-native",
                                &json!({"op":"attached","work_id":id,"agent_id":aid,"task_id":tid}),
                            )?;
                            let task = request(
                                c,
                                &json!({"protocol_version":1,"command_id":Uuid::new_v4().to_string(),"type":"GetTask","agent_id":aid,"payload":{"task_id":tid}}),
                            )?;
                            if task["data"]["state"] == "Created" {
                                native_task(
                                    c,
                                    "task-input",
                                    &json!({"agent_id":aid,"task_id":tid,"provider":crate::tools::binding(&provider),"search_revision":self.search.lock().unwrap().public()["revision"]}),
                                )?;
                            }
                            self.start_plan_worker(c.clone(), aid.into(), tid.into());
                        }
                        _ => return Err("UnknownExecutionWork".into()),
                    }
                    Ok(())
                })();
                if let Err(reason) = result {
                    self.tools.lock().unwrap().execution_state(eid, "Paused")?;
                    self.cancel_execution_children(eid);
                    native_task(
                        c,
                        "execution-native",
                        &json!({"op":"denied","work_id":id,"agent_id":aid,"reason":reason}),
                    )?;
                }
            }
            // A lost TaskRunning notification cannot strand a known running child.
            if matches!(e["state"].as_str(), Some("Running" | "Waiting")) {
                for n in e["nodes"].as_array().ok_or("NodesRequired")? {
                    if matches!(n["state"].as_str(), Some("Running" | "Created")) {
                        if let Some(tid) = n["task_id"].as_str() {
                            self.start_plan_worker(c.clone(), aid.into(), tid.into());
                        }
                    }
                }
            }
        }
        Ok(())
    }
}
