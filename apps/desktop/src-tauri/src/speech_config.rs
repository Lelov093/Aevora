//! Independent Host-owned speech purposes. Importing a key never enables either purpose.
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub struct Vault {
    pub config: Value,
    pub usage: Vec<Value>,
    pub error: Option<String>,
    pub testing_unlimited: bool,
    data: PathBuf,
}
fn defaults() -> Value {
    json!({"revision":0,"region":"cn-beijing","workspace_id":"",
      "asr":{"model":"qwen-audio-3.1-asr-flash-streaming","api_key":"","enabled":false,
        "grant_id":Uuid::new_v4().to_string(),"max_calls":4,"max_seconds":120},
      "tts":{"model":"qwen-audio-3.1-tts-flash","api_key":"","enabled":false,
        "grant_id":Uuid::new_v4().to_string(),"voice":"longanhuan_v3.1","rate":1.0,
        "max_calls":6,"max_characters":4000,"free_until":""}})
}
fn tts_voice(model: &Value) -> Option<&'static str> {
    match model.as_str()? {
        "qwen-audio-3.0-tts-flash" => Some("longanhuan_v3.6"),
        "qwen-audio-3.1-tts-flash" => Some("longanhuan_v3.1"),
        _ => None,
    }
}
fn validate_models(c: &Value) -> Result<(), String> {
    if c["asr"]["model"] != "qwen-audio-3.1-asr-flash-streaming" {
        return Err("当前仅接入已批准的 ASR 模型。".into());
    }
    let voice = tts_voice(&c["tts"]["model"]).ok_or("当前仅接入已批准的流式 TTS 模型。")?;
    if c["tts"]["voice"] != voice {
        return Err(format!("此 TTS 模型请使用对应系统音色 {voice}。"));
    }
    Ok(())
}
pub fn valid_workspace(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}
pub fn endpoint(c: &Value) -> Result<String, String> {
    if c["region"] != "cn-beijing" || !valid_workspace(c["workspace_id"].as_str().unwrap_or("")) {
        return Err("请填写有效的北京业务空间 ID；跨地域设置需重新确认。".into());
    }
    Ok(format!(
        "wss://{}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference",
        c["workspace_id"].as_str().unwrap()
    ))
}
pub fn tts_available(c: &Value, now: chrono::DateTime<chrono::Utc>) -> Result<(), String> {
    let date = chrono::NaiveDate::parse_from_str(
        c["tts"]["free_until"].as_str().unwrap_or(""),
        "%Y-%m-%d",
    )
    .map_err(|_| "请设置免费额度截止日，并确认控制台的用完即停。")?;
    // Conservative boundary: stop at the beginning of the stated expiry day (Beijing).
    let until = date.and_hms_opt(0, 0, 0).unwrap().and_utc() - chrono::Duration::hours(8);
    if now >= until {
        return Err("TTS 免费额度已到截止日，朗读已暂停；付费使用需另行批准。".into());
    }
    Ok(())
}
impl Vault {
    pub fn load(root: &Path, data: &Path) -> Self {
        let mut v = Self {
            config: defaults(),
            usage: vec![],
            error: None,
            testing_unlimited: false,
            data: data.into(),
        };
        let p = data.join("speech.dpapi");
        if p.exists() {
            let result = fs::read(&p)
                .map_err(|_| "语音配置读取失败".to_string())
                .and_then(|b| crate::provider::crypt(&b, false))
                .and_then(|b| {
                    serde_json::from_slice::<Value>(&b).map_err(|_| "语音配置格式不支持".into())
                });
            match result {
                Ok(c) => v.config = c,
                Err(e) => v.error = Some(e),
            }
        } else if cfg!(debug_assertions) {
            if let Err(e) = v.import(root) {
                v.error = Some(e);
            }
        }
        let ledger = data.join("speech-usage.json");
        if ledger.exists() {
            match fs::read(&ledger)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
            {
                Some(u) => v.usage = u,
                None => v.error = Some("语音用量台账无法读取，调用保持关闭。".into()),
            }
        }
        let mut interrupted = false;
        for u in &mut v.usage {
            if u["state"] == "Running" {
                u["state"] = json!("Interrupted");
                interrupted = true;
            }
        }
        if interrupted {
            if let Err(e) = v.save_usage() {
                v.error = Some(e);
            }
        }
        v
    }
    fn persist(&self) -> Result<(), String> {
        let b = serde_json::to_vec(&self.config).map_err(|_| "语音配置保存失败")?;
        let encrypted = crate::provider::crypt(&b, true)?;
        fs::write(self.data.join("speech.dpapi.tmp"), encrypted).map_err(|_| "语音配置保存失败")?;
        fs::rename(
            self.data.join("speech.dpapi.tmp"),
            self.data.join("speech.dpapi"),
        )
        .map_err(|_| "语音配置保存失败".into())
    }
    pub fn import(&mut self, root: &Path) -> Result<(), String> {
        let text = fs::read_to_string(root.join(".env")).map_err(|_| "未找到可读的本机 .env")?;
        let values: std::collections::BTreeMap<_, _> = text
            .trim_start_matches('\u{feff}')
            .lines()
            .filter(|l| !l.trim_start().starts_with('#'))
            .filter_map(|l| l.split_once('='))
            .map(|(k, v)| (k.trim(), v.trim().trim_matches(['\'', '"'])))
            .collect();
        let old = self.config.clone();
        for (env, field) in [
            ("AEVORA_SPEECH_REGION", "region"),
            ("AEVORA_SPEECH_WORKSPACE_ID", "workspace_id"),
        ] {
            if let Some(x) = values.get(env) {
                self.config[field] = json!(x);
            }
        }
        for (env, purpose, field) in [
            ("AEVORA_ASR_MODEL", "asr", "model"),
            ("AEVORA_ASR_API_KEY", "asr", "api_key"),
            ("AEVORA_TTS_MODEL", "tts", "model"),
            ("AEVORA_TTS_API_KEY", "tts", "api_key"),
            ("AEVORA_TTS_VOICE", "tts", "voice"),
            ("AEVORA_TTS_FREE_UNTIL", "tts", "free_until"),
        ] {
            if let Some(x) = values.get(env) {
                self.config[purpose][field] = json!(x);
            }
        }
        self.config["asr"]["enabled"] = json!(false);
        self.config["tts"]["enabled"] = json!(false);
        self.config["revision"] = json!(old["revision"].as_u64().unwrap_or(0) + 1);
        if let Err(e) = self.persist() {
            self.config = old;
            return Err(e);
        }
        self.error = None;
        Ok(())
    }
    pub fn public(&self) -> Value {
        let mut c = self.config.clone();
        c["testing_unlimited"] = json!(self.testing_unlimited);
        for p in ["asr", "tts"] {
            c[p]["credential_present"] = json!(!c[p]["api_key"].as_str().unwrap_or("").is_empty());
            c[p].as_object_mut().unwrap().remove("api_key");
            let u: Vec<_> = self
                .usage
                .iter()
                .filter(|u| u["grant_id"] == c[p]["grant_id"])
                .collect();
            c[p]["calls_started"] = json!(u.len());
            c[p]["units_submitted"] = json!(u
                .iter()
                .map(|u| u["submitted"].as_f64().unwrap_or(0.0))
                .sum::<f64>());
        }
        c["endpoint"] = json!(endpoint(&c).ok());
        c["store_error"] = json!(self.error);
        c["tts"]["availability_error"] = json!(tts_available(&c, chrono::Utc::now()).err());
        c
    }
    pub fn configure(&mut self, p: &Value) -> Result<(), String> {
        if p["revision"] != self.config["revision"] {
            return Err("语音设置已变化，请重新载入。".into());
        }
        let mut c = self.config.clone();
        c["region"] = p["region"].clone();
        c["workspace_id"] = p["workspace_id"].clone();
        let destination_changed = c["region"] != self.config["region"]
            || c["workspace_id"] != self.config["workspace_id"];
        for name in ["asr", "tts"] {
            let q = &p[name];
            let enabled = q["enabled"] == true;
            c[name]["enabled"] = json!(enabled);
            if enabled && q["consent"] != true {
                return Err("请独立确认语音用途、内容和预算。".into());
            }
            let key = q["api_key"].as_str().unwrap_or("").trim();
            if !key.is_empty() {
                c[name]["api_key"] = json!(key);
            } else if destination_changed {
                c[name]["api_key"] = json!("");
            }
            if enabled && c[name]["api_key"].as_str().unwrap_or("").is_empty() {
                return Err("此目的地需要重新填写 Key。".into());
            }
            let calls = q["max_calls"]
                .as_u64()
                .filter(|n| *n > 0 && *n <= 1000)
                .ok_or("调用上限须为1–1000")?;
            c[name]["max_calls"] = json!(calls);
            let unit = if name == "asr" {
                "max_seconds"
            } else {
                "max_characters"
            };
            let limit = q[unit]
                .as_u64()
                .filter(|n| *n > 0 && *n <= 1_000_000)
                .ok_or("用量上限无效")?;
            c[name][unit] = json!(limit);
            if q["new_budget"] == true {
                c[name]["grant_id"] = json!(Uuid::new_v4().to_string());
            }
        }
        c["asr"]["model"] = p["asr"]["model"].clone();
        c["tts"]["model"] = p["tts"]["model"].clone();
        c["tts"]["voice"] = p["tts"]["voice"].clone();
        validate_models(&c)?;
        c["tts"]["rate"] = json!(p["tts"]["rate"]
            .as_f64()
            .filter(|r| *r >= 0.5 && *r <= 2.0)
            .ok_or("语速须为0.5–2")?);
        c["tts"]["free_until"] = p["tts"]["free_until"].clone();
        if c["asr"]["enabled"] == true || c["tts"]["enabled"] == true {
            endpoint(&c)?;
        }
        if c["tts"]["enabled"] == true {
            if p["tts"]["free_tier_only_confirmed"] != true {
                return Err("请确认百炼的免费额度用完即停已开启。".into());
            }
            tts_available(&c, chrono::Utc::now())?;
        }
        c["revision"] = json!(self.config["revision"].as_u64().unwrap_or(0) + 1);
        let old = std::mem::replace(&mut self.config, c);
        if let Err(e) = self.persist() {
            self.config = old;
            return Err(e);
        }
        Ok(())
    }
    fn save_usage(&self) -> Result<(), String> {
        fs::write(
            self.data.join("speech-usage.json.tmp"),
            serde_json::to_vec_pretty(&self.usage).unwrap(),
        )
        .map_err(|_| "语音用量台账保存失败")?;
        fs::rename(
            self.data.join("speech-usage.json.tmp"),
            self.data.join("speech-usage.json"),
        )
        .map_err(|_| "语音用量台账保存失败".into())
    }
    pub fn reserve(&mut self, purpose: &str, id: &str, units: f64) -> Result<Value, String> {
        if self.error.is_some() {
            return Err("语音配置或用量台账不可用，未调用服务。".into());
        }
        let c = &self.config;
        let p = &c[purpose];
        if p["enabled"] != true || p["api_key"].as_str().unwrap_or("").is_empty() {
            return Err("语音用途未开启，请在设置中独立授权。".into());
        }
        endpoint(c)?;
        if purpose == "tts" {
            validate_models(c)?;
            tts_available(c, chrono::Utc::now())?;
        }
        let prior: Vec<_> = self
            .usage
            .iter()
            .filter(|u| u["grant_id"] == p["grant_id"])
            .collect();
        let limit = if purpose == "asr" {
            "max_seconds"
        } else {
            "max_characters"
        };
        let reserved: f64 = prior
            .iter()
            .map(|u| {
                if matches!(u["state"].as_str(), Some("Running" | "Interrupted")) {
                    u["reserved"].as_f64().unwrap_or(0.0)
                } else {
                    u["submitted"].as_f64().unwrap_or(0.0)
                }
            })
            .sum();
        if !self.testing_unlimited
            && (prior.len() >= p["max_calls"].as_u64().unwrap_or(0) as usize
                || reserved + units > p[limit].as_f64().unwrap_or(0.0))
        {
            return Err("语音预算已用尽；没有自动增加或重试。".into());
        }
        let config = c.clone();
        self.usage.push(json!({"operation_id":id,"purpose":purpose,"grant_id":p["grant_id"],"model":p["model"],
            "started_at":chrono::Utc::now().to_rfc3339(),"state":"Running","reserved":units,"submitted":0,"usage":null,"usage_state":"unknown","handshake_attempted":false}));
        if let Err(e) = self.save_usage() {
            self.usage.pop();
            return Err(e);
        }
        Ok(config)
    }
    pub fn update_usage(&mut self, id: &str, patch: &Value) -> Result<(), String> {
        if let Some(u) = self.usage.iter_mut().find(|u| u["operation_id"] == id) {
            for (k, v) in patch.as_object().ok_or("Invalid speech usage update")? {
                u[k] = v.clone();
            }
            self.save_usage()?;
        }
        Ok(())
    }
}
