//! Persistent Host authority shared by all children of a Goal execution.
use crate::tools::{binding, Authority};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

pub fn valid_time(value: &Value) -> Result<(), String> {
    let expiry = DateTime::parse_from_rfc3339(
        value["scope"]["expires_at"]
            .as_str()
            .ok_or("ExpiryRequired")?,
    )
    .map_err(|_| "ExplicitExpiryRequired")?;
    if expiry <= Utc::now() {
        return Err("ExecutionExpired".into());
    }
    if !matches!(value["state"].as_str(), Some("Active" | "Planning")) {
        return Err("ExecutionStopped".into());
    }
    let mut active = value["active_ms"].as_u64().unwrap_or(0);
    let stamp = Utc::now().timestamp_millis();
    for (key, done) in [("reservations", "settled"), ("charges", "finished")] {
        if let Some(entries) = value[key].as_object() {
            for r in entries.values() {
                if r[done] != true {
                    active += stamp
                        .saturating_sub(r["started_at"].as_i64().unwrap_or(stamp))
                        .max(0) as u64;
                }
            }
        }
    }
    if active >= value["scope"]["max_active_seconds"].as_u64().unwrap_or(0) * 1000 {
        return Err("ExecutionTimeLimit".into());
    }
    Ok(())
}

pub fn reviewed_execution(c: &Value, provider: &Value) -> Result<Value, String> {
    let scope = &c["payload"]["scope"];
    if let Some(method) = scope.get("method_ref") {
        if method["mode"] != "active" || method["proposal_id"].as_str().unwrap_or("").is_empty()
            || method["revision"].as_u64().is_none() {
            return Err("ExplicitAdoptedWorkStrategyRequired".into());
        }
    }
    if c["payload"]["allow_outbound"] != true
        || scope["provider"] != binding(provider)
        || provider["chat_allowed"] != true
        || provider["api_key"].as_str().unwrap_or("").is_empty()
    {
        return Err("ApproveCurrentPlanningProviderAndDataPurpose".into());
    }
    let mut normalized = json!({"payload":{"tools":scope["tools"]}});
    crate::general_host::validate_scope(&mut normalized)?;
    if scope["max_calls"].as_u64().unwrap_or(0) == 0
        || scope["max_tokens"].as_u64().unwrap_or(0) == 0
        || scope["max_tasks"].as_u64().unwrap_or(0) == 0
    {
        return Err("BoundedExecutionBudgetRequired".into());
    }
    let snapshot = if scope["allow_future_files"] == true {
        json!({})
    } else {
        crate::general_host::scope_versions(&scope["tools"])?
    };
    let value = json!({"request":c,"agent_id":c["agent_id"],"goal_id":c["payload"]["goal_id"],"scope":scope,"state":"Planning",
            "provider":binding(provider),"calls":0,"tokens":0,"tasks":{},"reservations":{},"charges":{},"counts":{},"conditions":{},"snapshot":snapshot,"active_ms":0});
    valid_time(&value)?;
    Ok(value)
}

impl Authority {
    pub fn create_execution(&mut self, c: &Value, provider: &Value) -> Result<Value, String> {
        let eid = c["command_id"].as_str().ok_or("ExecutionIDRequired")?;
        if let Some(old) = self.value["executions"].get(eid) {
            if old["request"] != *c {
                return Err("ExecutionIDReused".into());
            }
            return Ok(c.clone());
        }
        let value = reviewed_execution(c, provider)?;
        let mut next = self.value.clone();
        next["executions"][eid] = value;
        self.save(next)?;
        Ok(c.clone())
    }
    pub fn execution(&self, eid: &str) -> Result<&Value, String> {
        let value = self.value["executions"]
            .get(eid)
            .ok_or("ExecutionPermissionMissing")?;
        valid_time(value)?;
        Ok(value)
    }
    pub fn check_parent(&self, grant: &Value) -> Result<(), String> {
        if let Some(eid) = grant["execution_id"].as_str() {
            self.execution(eid)?;
        }
        Ok(())
    }
    pub fn execution_state(&mut self, eid: &str, state: &str) -> Result<(), String> {
        if self.value["executions"].get(eid).is_none() {
            return Err("ExecutionPermissionMissing".into());
        }
        if self.value["executions"][eid]["state"] == state {
            return Ok(());
        }
        let mut next = self.value.clone();
        next["executions"][eid]["state"] = json!(state);
        self.save(next)
    }
    pub fn execution_budget(&self, eid: &str) -> Value {
        let p = &self.value["executions"][eid];
        json!({"calls":p["calls"],"tokens":p["tokens"],"counts":p["counts"],"active_ms":p["active_ms"],"scope":p["scope"],"state":p["state"]})
    }
    pub fn reserve_execution_model(
        &mut self,
        eid: &str,
        id: &str,
        provider: &Value,
    ) -> Result<(), String> {
        let p = self.execution(eid)?.clone();
        if p["provider"] != binding(provider) || provider["chat_allowed"] != true {
            return Err("ExecutionProviderChanged".into());
        }
        if p["reservations"].get(id).is_some() {
            return Ok(());
        }
        let reserve = provider["max_input_tokens"].as_u64().unwrap_or(4096)
            + provider["max_output_tokens"].as_u64().unwrap_or(1024);
        let calls = p["calls"].as_u64().unwrap_or(0);
        let tokens = p["tokens"].as_u64().unwrap_or(0);
        if calls >= p["scope"]["max_calls"].as_u64().unwrap_or(0)
            || tokens + reserve > p["scope"]["max_tokens"].as_u64().unwrap_or(0)
        {
            return Err("ExecutionModelBudget".into());
        }
        let mut next = self.value.clone();
        let v = &mut next["executions"][eid];
        v["calls"] = json!(calls + 1);
        v["tokens"] = json!(tokens + reserve);
        v["reservations"][id] =
            json!({"reserved":reserve,"settled":false,"started_at":Utc::now().timestamp_millis()});
        self.save(next)
    }
    pub fn settle_execution_model(
        &mut self,
        eid: &str,
        id: &str,
        metadata: &Value,
    ) -> Result<(), String> {
        let p = self.value["executions"]
            .get(eid)
            .ok_or("ExecutionPermissionMissing")?;
        let old = &p["reservations"][id];
        if old.is_null() || old["settled"] == true {
            return Ok(());
        }
        let reserved = old["reserved"].as_u64().unwrap_or(0);
        let actual = metadata["usage"]["total_tokens"]
            .as_u64()
            .unwrap_or(reserved);
        let ms = (metadata["elapsed_seconds"].as_f64().unwrap_or(0.0) * 1000.0) as u64;
        let mut next = self.value.clone();
        let v = &mut next["executions"][eid];
        v["tokens"] = json!(p["tokens"].as_u64().unwrap_or(0).saturating_sub(reserved) + actual);
        v["active_ms"] = json!(p["active_ms"].as_u64().unwrap_or(0) + ms);
        v["reservations"][id]["settled"] = json!(true);
        v["reservations"][id]["metadata"] = metadata.clone();
        self.save(next)
    }
    pub fn charge_execution(
        &mut self,
        grant: &Value,
        id: &str,
        counts: Value,
    ) -> Result<(), String> {
        let Some(eid) = grant["execution_id"].as_str() else {
            return Ok(());
        };
        let p = self.execution(eid)?.clone();
        if p["charges"].get(id).is_some() {
            return Ok(());
        }
        let mut next = self.value.clone();
        let v = &mut next["executions"][eid];
        for (key, amount) in counts.as_object().ok_or("CountsRequired")? {
            let total =
                p["counts"][key].as_u64().unwrap_or(0) + amount.as_u64().ok_or("CountRequired")?;
            if total > p["scope"][format!("max_{key}")].as_u64().unwrap_or(0) {
                return Err(format!("ExecutionLimit:{key}"));
            }
            v["counts"][key] = json!(total);
        }
        v["charges"][id] = json!({"counts":counts,"started_at":Utc::now().timestamp_millis()});
        self.save(next)
    }
    pub fn execution_child(&mut self, eid: &str, tid: &str) -> Result<(), String> {
        let p = self.execution(eid)?.clone();
        if p["state"] != "Active" {
            return Err("ExecutionPlanNotApproved".into());
        }
        if self.value["grants"][tid]["command"]["payload"]["method_ref"] != p["scope"]["method_ref"] {
            return Err("ChildWorkStrategyOutsideReviewedScope".into());
        }
        if p["tasks"].get(tid).is_some() {
            return Ok(());
        }
        if p["tasks"].as_object().map(|a| a.len()).unwrap_or(0)
            >= p["scope"]["max_tasks"].as_u64().unwrap_or(0) as usize
        {
            return Err("ExecutionTaskLimit".into());
        }
        let mut next = self.value.clone();
        next["executions"][eid]["tasks"][tid] = json!(true);
        next["grants"][tid]["execution_id"] = json!(eid);
        self.save(next)
    }
    pub fn execution_read(&self, grant: &Value, d: &Value, observed: &Value) -> Result<(), String> {
        let Some(eid) = grant["execution_id"].as_str() else {
            return Ok(());
        };
        let p = self.execution(eid)?;
        if p["scope"]["allow_future_files"] == true || d["op"] == "list_files" {
            return Ok(());
        }
        let root = d["root"].as_str().ok_or("RootRequired")?;
        let mut versions = Vec::new();
        if d["op"] == "read_file" {
            versions.push((&d["path"], &observed["version"]));
        } else if d["op"] == "search_files" {
            for hit in observed["matches"]
                .as_array()
                .ok_or("SearchMatchesRequired")?
            {
                versions.push((&hit["path"], &hit["version"]));
            }
        }
        for (path, version) in versions {
            let key = format!("{root}/{}", path.as_str().ok_or("PathRequired")?);
            if p["snapshot"][&key].is_null() || p["snapshot"][&key] != *version {
                return Err("ExecutionFileVersionNotAuthorized".into());
            }
        }
        Ok(())
    }
    pub fn execution_products(&mut self, stage: &Value, receipt: &Value) -> Result<(), String> {
        let Some(eid) = self.value["grants"][stage["task_id"].as_str().unwrap_or("")]
            ["execution_id"]
            .as_str()
            .map(str::to_owned)
        else {
            return Ok(());
        };
        let mut next = self.value.clone();
        let p = &mut next["executions"][&eid];
        if let Some(products) = receipt["products"].as_array() {
            for product in products {
                if receipt["outcome"] == "Success" {
                    p["snapshot"][format!(
                        "{}/{}",
                        product["root"].as_str().unwrap_or(""),
                        product["path"].as_str().unwrap_or("")
                    )] = product["version"].clone();
                }
            }
        }
        let id = stage["action_id"].as_str().unwrap_or("");
        let started = p["charges"][id]["started_at"]
            .as_i64()
            .unwrap_or(Utc::now().timestamp_millis());
        let elapsed = Utc::now().timestamp_millis().saturating_sub(started).max(0) as u64;
        if p["charges"][id]["finished"] != true {
            p["active_ms"] = json!(p["active_ms"].as_u64().unwrap_or(0) + elapsed);
            p["charges"][id]["finished"] = json!(true);
        }
        self.save(next)
    }
    pub fn finish_execution_charge(&mut self, grant: &Value, id: &str) -> Result<(), String> {
        let Some(eid) = grant["execution_id"].as_str() else {
            return Ok(());
        };
        let p = &self.value["executions"][eid];
        let r = &p["charges"][id];
        if r.is_null() || r["finished"] == true {
            return Ok(());
        }
        let elapsed = Utc::now()
            .timestamp_millis()
            .saturating_sub(
                r["started_at"]
                    .as_i64()
                    .unwrap_or(Utc::now().timestamp_millis()),
            )
            .max(0) as u64;
        let mut next = self.value.clone();
        let v = &mut next["executions"][eid];
        v["active_ms"] = json!(p["active_ms"].as_u64().unwrap_or(0) + elapsed);
        v["charges"][id]["finished"] = json!(true);
        self.save(next)
    }
    pub fn execution_condition(&mut self, eid: &str, node: &Value) -> Result<bool, String> {
        let p = self.execution(eid)?.clone();
        let c = &node["condition"];
        if c.is_null() {
            return Ok(true);
        }
        let path = crate::general_host::resolve(
            &p["scope"]["tools"],
            c["root"].as_str().ok_or("RootRequired")?,
            c["path"].as_str().ok_or("PathRequired")?,
            false,
        )?;
        let key = node["id"].as_str().ok_or("NodeRequired")?;
        if !path.exists() {
            if c["mode"] == "changed" && p["conditions"][key].is_null() {
                let mut next = self.value.clone();
                next["executions"][eid]["conditions"][key] = json!({"version":null});
                self.save(next)?;
            }
            return Ok(false);
        }
        let current = json!(crate::document_resources::digest(
            &crate::general_host::bytes(&path, 8 * 1024 * 1024)?
        ));
        if c["mode"] == "exists" {
            return Ok(true);
        }
        let baseline = &p["conditions"][key];
        if baseline.is_null() {
            let mut next = self.value.clone();
            next["executions"][eid]["conditions"][key] = json!({"version":current});
            self.save(next)?;
            return Ok(false);
        }
        let changed = baseline["version"] != current;
        if changed {
            let mut next = self.value.clone();
            next["executions"][eid]["conditions"][key]["consumed"] = current;
            self.save(next)?;
        }
        Ok(changed)
    }
}
