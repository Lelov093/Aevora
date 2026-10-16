//! Host-owned resource range for a dynamic task. Model actions cannot enlarge this grant.
use crate::tools::{binding, destination, source, Authority};
use serde_json::{json, Value};

impl Authority {
    pub fn create_agent(
        &mut self,
        c: &Value,
        provider: &Value,
        search: &Value,
    ) -> Result<Value, String> {
        let tid = c["command_id"].as_str().ok_or("Task ID required")?;
        if let Some(grant) = self.value["grants"].get(tid) {
            if grant["request"] != *c {
                return Err("Task ID reused with a different scope".into());
            }
            return Ok(grant["command"].clone());
        }
        let p = &c["payload"];
        if p["allow_file_outbound"] != true
            || p["provider"] != binding(provider)
            || provider["chat_allowed"] != true
            || provider["api_key"].as_str().unwrap_or("").is_empty()
        {
            return Err("Approve the current model and resource purpose".into());
        }
        let max = p["max_decisions"]
            .as_u64()
            .filter(|v| (2..=24).contains(v))
            .ok_or("Choose a bounded decision budget")?;
        let network = p["allow_search"] == true;
        if network && (search["allowed"] != true || search["credential_present"] != true) {
            return Err("Current search-purpose permission required".into());
        }
        let mut normalized = c.clone();
        let sources = p["sources"]
            .as_array()
            .filter(|a| a.len() <= 8)
            .ok_or("Choose at most eight local sources")?;
        normalized["payload"]["sources"] = json!(sources
            .iter()
            .map(|s| source(s.as_str().ok_or("Source path required")?))
            .collect::<Result<Vec<_>, _>>()?);
        if normalized["payload"]["outputs"].as_array().filter(|a|a.len()<=2).is_none() {return Err("Choose at most two new outputs".into());}
        crate::general_host::validate_scope(&mut normalized)?;
        let mut used = std::collections::HashSet::new();
        crate::document_host::validate_resources(&mut normalized, &mut used)?;
        let outputs = normalized["payload"]["outputs"].as_array_mut().ok_or("Outputs required")?;
        for output in outputs {
            let path = destination(output["path"].as_str().ok_or("Output path required")?)?;
            if !used.insert(path.to_lowercase().replace('/', "\\")) {
                return Err("Choose distinct outputs".into());
            }
            output["path"] = json!(path);
        }
        let mut next = self.value.clone();
        next["grants"][tid] = json!({"request":c,"command":normalized,"agent_id":c["agent_id"],"enabled":true,
            "provider":binding(provider),"dynamic":true,"max_decisions":max,"allow_search":network,
            "search_revision":search["revision"],"urls":normalized["payload"]["tools"]["urls"].as_array().cloned().unwrap_or_default(),"search_calls_started":0,"web_reads_started":0});
        self.save(next)?;
        Ok(normalized)
    }

    pub(crate) fn agent_scope(&self, task: &Value, provider: &Value) -> Result<&Value, String> {
        let aid = task["agent_id"].as_str().ok_or("Agent required")?;
        let tid = task["task_id"].as_str().ok_or("Task required")?;
        self.outbound(aid, tid, provider)?;
        let grant = self.grant(aid, tid)?;
        if task["kind"] != "agent"
            || task["permission"] != 1
            || task["state"] != "Running"
            || grant["dynamic"] != true
            || task["current_step"]["position"]
                .as_u64()
                .unwrap_or(u64::MAX)
                >= grant["max_decisions"].as_u64().unwrap_or(0)
        {
            return Err("Action is outside the Host-reviewed scope".into());
        }
        if task["runs"][0]["context"]["active_ms"].as_u64().unwrap_or(0) >= grant["command"]["payload"]["tools"]["execution_seconds"].as_u64().unwrap_or(900) * 1000 {return Err("ExecutionTimeLimit".into());}
        Ok(grant)
    }

    pub fn read_agent_step(&self, task: &Value, provider: &Value) -> Result<Value, String> {
        let grant = self.agent_scope(task, provider)?;
        let d = &task["current_step"]["definition"];
        if d["op"] != "read" {
            return Err("Current action is not a local read".into());
        }
        let resource = d["resource"].as_str().ok_or("Resource required")?;
        let (suffix, output) = if let Some(n) = resource.strip_prefix("source") {
            (n, false)
        } else if let Some(n) = resource.strip_prefix("output") {
            (n, true)
        } else {
            return Err("Unknown resource".into());
        };
        let index = suffix
            .parse::<usize>()
            .ok()
            .and_then(|n| n.checked_sub(1))
            .ok_or("Invalid resource")?;
        let path = if output {
            &grant["command"]["payload"]["outputs"][index]["path"]
        } else {
            &grant["command"]["payload"]["sources"][index]
        };
        let path = path.as_str().ok_or("Resource outside the selected scope")?;
        let content = if output {
            crate::tools::read_exact(path, 1024 * 1024)?
        } else {
            crate::tools::read(path, 1024 * 1024)?
        };
        if output {
            let writer = task["runs"][0]["steps"]
                .as_array()
                .and_then(|steps| {
                    steps.iter().find(|s| {
                        s["definition"]["op"] == "write"
                            && s["definition"]["output"] == resource
                            && s["state"] == "Completed"
                            && s["action"]["receipt"]["outcome"] == "Success"
                    })
                })
                .ok_or("Output has no confirmed write")?;
            if content
                != writer["action"]["body"]
                    .as_str()
                    .ok_or("Reviewed output body unavailable")?
            {
                return Err("ArtifactChanged".into());
            }
        }
        let start = d["start"].as_u64().ok_or("Read start required")? as usize;
        let length = d["length"]
            .as_u64()
            .filter(|v| (1..=2048).contains(v))
            .ok_or("Bounded read length required")? as usize;
        let total = content.chars().count();
        if start > total {
            return Err("Read start is beyond the actual file".into());
        }
        let text: String = content.chars().skip(start).take(length).collect();
        let end = start + text.chars().count();
        Ok(
            json!({"path":path,"content":text,"start":start,"end":end,"total_characters":total,"complete":start==0&&end==total}),
        )
    }

    pub fn begin_agent_network(
        &mut self,
        task: &Value,
        provider: &Value,
        search: &Value,
        id: &str,
    ) -> Result<Vec<String>, String> {
        let grant = self.agent_scope(task, provider)?;
        let direct = task["current_step"]["definition"]["op"] == "read_web" && grant["command"]["payload"]["tools"]["urls"].as_array().map(|v|v.contains(&task["current_step"]["definition"]["url"])).unwrap_or(false);
        if !direct && (grant["allow_search"] != true
            || search["allowed"] != true
            || search["revision"] != grant["search_revision"])
        {
            return Err("NetworkPermissionChanged".into());
        }
        let d = &task["current_step"]["definition"];
        let search_action = d["op"] == "search";
        let permitted = if search_action {
            d["query"]
                .as_str()
                .map(|q| !q.trim().is_empty() && q.chars().count() <= 300)
                .unwrap_or(false)
        } else if d["op"] == "read_web" {
            grant["urls"]
                .as_array()
                .map(|a| a.contains(&d["url"]))
                .unwrap_or(false)
        } else {
            false
        };
        if !permitted || self.value["actions"].get(id).is_some() {
            return Err("Network action is outside its scope or repeated".into());
        }
        let key = if search_action {
            "search_calls_started"
        } else {
            "web_reads_started"
        };
        let count = grant[key].as_u64().unwrap_or(0);
        if count >= if search_action { 3 } else { 6 } {
            return Err("SearchRequestLimit".into());
        }
        let tid = task["task_id"].as_str().ok_or("Task required")?;
        let owned=grant.clone();
        self.charge_execution(&owned,id,if search_action{json!({"searches":1})}else{json!({"pages":1})})?;
        let mut next = self.value.clone();
        next["grants"][tid][key] = json!(count + 1);
        next["actions"][id] = json!({"agent_id":task["agent_id"],"task_id":tid,"kind":d["op"],"state":"Unknown","error":"NetworkRequestStarted"});
        self.save(next)?;
        Ok(Vec::new()) // Cross-host redirects are observations, not an automatic authority expansion.
    }

    pub fn finish_agent_network(
        &mut self,
        id: &str,
        metadata: &Value,
        result: &Value,
    ) -> Result<(), String> {
        self.finish_network(id, metadata)?;
        if self.value["actions"][id]["kind"] != "search" || result["results"].as_array().is_none() {
            return Ok(());
        }
        let tid = self.value["actions"][id]["task_id"]
            .as_str()
            .ok_or("Task required")?;
        let mut next = self.value.clone();
        let urls = next["grants"][tid]["urls"]
            .as_array_mut()
            .ok_or("Source scope unavailable")?;
        for item in result["results"].as_array().unwrap() {
            let url = item["url"].as_str().ok_or("Actual source URL required")?;
            if crate::network::valid_url(url).is_ok() && !urls.contains(&item["url"]) {
                urls.push(item["url"].clone());
            }
        }
        self.save(next)
    }
}
