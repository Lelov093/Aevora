// Host-owned configuration and current-user DPAPI storage; nothing reaches the WebView except metadata.
use serde_json::{json, Value};
use std::{fs, path::Path, ptr};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    },
};

pub struct ProviderVault {
    pub value: Value,
    pub error: Option<String>,
}
pub(crate) fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output: CRYPT_INTEGER_BLOB = unsafe { std::mem::zeroed() };
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err("Windows credential store unavailable for this user".into());
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as *mut _);
    }
    Ok(result)
}
pub fn validate(payload: &Value, old: &Value) -> Result<Value, String> {
    let base = payload["base_url"]
        .as_str()
        .ok_or("Provider base URL required")?
        .trim()
        .trim_end_matches('/');
    let url = reqwest::Url::parse(base).map_err(|_| "Invalid Provider URL")?;
    if !(url.scheme() == "https"
        || (url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))))
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
        || base.ends_with("/chat/completions")
    {
        return Err(
            "Use HTTPS (or explicit loopback HTTP), API prefix only, without credentials/query"
                .into(),
        );
    }
    let model = payload["model"].as_str().ok_or("Model required")?.trim();
    if model.is_empty() || model.contains(',') || model.len() > 120 {
        return Err("Configure exactly one model".into());
    }
    let supplied = payload["api_key"].as_str().unwrap_or("");
    let key = if supplied.is_empty() && old["base_url"] == base {
        old["api_key"].as_str().unwrap_or("")
    } else {
        supplied
    };
    if key.len() > 1000 {
        return Err("Invalid credential length".into());
    }
    let input = payload["max_input_tokens"]
        .as_u64()
        .ok_or("Input budget required")?;
    let output = payload["max_output_tokens"]
        .as_u64()
        .ok_or("Output budget required")?;
    if !(512..=32768).contains(&input) || !(32..=4096).contains(&output) {
        return Err("Invalid token budget".into());
    }
    let allowed = payload["chat_allowed"]
        .as_bool()
        .ok_or("Explicit Chat outbound purpose required")?;
    if allowed && key.is_empty() {
        return Err("API key required to enable Chat".into());
    }
    let mut next = json!({"base_url":base,"model":model,"api_key":key,"dialect":"openai-compatible",
        "profile":if url.host_str()==Some("dashscope.aliyuncs.com") {"dashscope"} else {"generic"},
        "chat_allowed":allowed,"max_input_tokens":input,"max_output_tokens":output,
        "idle_timeout_seconds":30,"total_timeout_seconds":120,"automatic_retries":0,
        "revision":old["revision"].as_u64().unwrap_or(0)+1});
    next["extraction"] = old["extraction"].clone();
    next["embedding"] = old["embedding"].clone();
    next["selection"] = old["selection"].clone();
    if let Some(allowed) = payload["selection_allowed"].as_bool() {
        next["selection"] = Value::Null;
        if allowed {
            let calls = payload["selection_max_calls"]
                .as_u64()
                .ok_or("Recall selection call budget required")?;
            if key.is_empty() || !(1..=1000).contains(&calls) {
                return Err("Recall selection requires a credential and 1..1000 calls".into());
            }
            next["selection"] = json!({"base_url":base,"model":model,"api_key":key,
                "dialect":"openai-compatible","profile":next["profile"],"selection_allowed":true,
                "max_input_tokens":32768,"max_output_tokens":4096,"max_calls":calls,
                "grant_id":uuid::Uuid::new_v4().to_string(),"revision":next["revision"],
                "data_categories":["current recall query","current valid Memory candidates"],
                "scope":"same explicit Chat destination/model/credential, isolated per Agent; relevance selection only",
                "idle_timeout_seconds":30,"total_timeout_seconds":120,"automatic_retries":0});
        }
    }
    if let Some(e) = payload.get("embedding") {
        let allowed = e["embedding_allowed"]
            .as_bool()
            .ok_or("Explicit Embedding purpose required")?;
        let embedding_base = e["base_url"]
            .as_str()
            .ok_or("Embedding URL required")?
            .trim()
            .trim_end_matches('/');
        if embedding_base.ends_with("/embeddings") {
            return Err("Use Embedding API prefix only".into());
        }
        let use_chat_key = e["use_chat_credential"].as_bool().unwrap_or(false);
        if use_chat_key && embedding_base != base {
            return Err("Chat credential reuse requires the same explicit destination".into());
        }
        let embedding_key = if use_chat_key {
            key
        } else {
            e["api_key"].as_str().unwrap_or("")
        };
        let mut config = validate(
            &json!({"base_url":embedding_base,"model":e["model"],"api_key":embedding_key,
            "chat_allowed":false,"max_input_tokens":4096,"max_output_tokens":32}),
            &old["embedding"],
        )?;
        if allowed && config["api_key"].as_str().unwrap_or("").is_empty() {
            return Err("Embedding credential required".into());
        }
        let calls = e["max_calls"]
            .as_u64()
            .ok_or("Embedding call budget required")?;
        let total = e["max_total_input_tokens"]
            .as_u64()
            .ok_or("Embedding total estimate budget required")?;
        if !(1..=1000).contains(&calls) || !(512..=1_000_000).contains(&total) {
            return Err("Invalid Embedding budget".into());
        }
        config["embedding_allowed"] = json!(allowed);
        config["dimensions"] = json!(1024);
        config["max_calls"] = json!(calls);
        config["max_total_input_tokens"] = json!(total);
        config["grant_id"] = json!(uuid::Uuid::new_v4().to_string());
        config["revision"] = next["revision"].clone();
        config["data_categories"] = json!(["current Active Memory body", "current recall query"]);
        config["scope"] = json!("current-user Agents, isolated per Agent; indexing and query encoding share this budget");
        config.as_object_mut().unwrap().remove("embedding");
        config.as_object_mut().unwrap().remove("extraction");
        next["embedding"] = config;
    }
    if let Some(allowed) = payload["extraction_allowed"].as_bool() {
        next["extraction"] = Value::Null;
        if allowed {
            if key.is_empty() {
                return Err("Key required for Memory Extraction".into());
            }
            let calls = payload["extraction_max_calls"]
                .as_u64()
                .ok_or("Extraction call budget required")?;
            if !(1..=100).contains(&calls) {
                return Err("Extraction call budget must be 1..100".into());
            }
            next["extraction"] = json!({"base_url":base,"model":model,"api_key":key,
                "dialect":"openai-compatible","profile":next["profile"],
                "extraction_allowed":true,"max_input_tokens":4096,"max_output_tokens":1024,
                "max_calls":calls,"grant_id":uuid::Uuid::new_v4().to_string(),
                "data_categories":["completed conversation turn","bounded current memories"],
                "scope":"local current-user Agents; pending and future completed turns",
                "idle_timeout_seconds":30,"total_timeout_seconds":120,"automatic_retries":0,
                "revision":next["revision"]});
        }
    }
    Ok(next)
}
pub fn public(config: &Value) -> Value {
    let mut value = config.clone();
    if let Some(object) = value.as_object_mut() {
        let key = object.remove("api_key");
        object.insert(
            "credential_present".into(),
            json!(key
                .and_then(|k| k.as_str().map(|s| !s.is_empty()))
                .unwrap_or(false)),
        );
        if let Some(extraction) = object.get_mut("extraction") {
            if !extraction.is_null() {
                *extraction = public(extraction);
            }
        }
        if let Some(embedding) = object.get_mut("embedding") {
            if !embedding.is_null() {
                *embedding = public(embedding);
            }
        }
        if let Some(selection) = object.get_mut("selection") {
            if !selection.is_null() {
                *selection = public(selection);
            }
        }
    }
    value
}
impl ProviderVault {
    pub fn load(root: &Path, data: &Path) -> Self {
        let path = data.join("provider.dpapi");
        let result = if path.exists() {
            fs::read(&path)
                .map_err(|_| "Cannot read Provider store".to_string())
                .and_then(|bytes| crypt(&bytes, false))
                .and_then(|bytes| {
                    serde_json::from_slice::<Value>(&bytes)
                        .map_err(|_| "Invalid Provider store".into())
                })
        } else {
            // Explicitly development-only import. Release builds use the native settings form.
            #[cfg(debug_assertions)]
            {
                import_env(root).and_then(|config| {
                    let value = json!({"config":config,"results":{}});
                    if !config.is_null() {
                        Self::save_value(data, &value)?;
                    }
                    Ok(value)
                })
            }
            #[cfg(not(debug_assertions))]
            {
                let _ = root;
                Ok(json!({"config":null,"results":{}}))
            }
        };
        match result {
            Ok(value) => Self { value, error: None },
            Err(error) => Self {
                value: json!({"config":null,"results":{}}),
                error: Some(error),
            },
        }
    }
    pub fn config(&self) -> Value {
        self.value["config"].clone()
    }
    pub fn save_value(data: &Path, value: &Value) -> Result<(), String> {
        let bytes = crypt(
            &serde_json::to_vec(value).map_err(|_| "Invalid Provider config")?,
            true,
        )?;
        let temp = data.join("provider.dpapi.tmp");
        fs::write(&temp, bytes).map_err(|_| "Cannot save Provider credentials")?;
        fs::rename(temp, data.join("provider.dpapi"))
            .map_err(|_| "Cannot commit Provider credentials".to_string())
    }
}

#[cfg(debug_assertions)]
fn import_env(root: &Path) -> Result<Value, String> {
    let path = root.join(".env");
    if !path.exists() {
        return Ok(Value::Null);
    }
    let text = fs::read_to_string(path).map_err(|_| "Cannot read development .env")?;
    let mut values = std::collections::BTreeMap::new();
    for line in text.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if line.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            values.insert(key.trim(), value.trim().trim_matches(['\'', '"']));
        }
    }
    let get = |key| values.get(key).copied().unwrap_or("");
    if get("AEVORA_PROVIDER_API_KEY").is_empty() {
        return Ok(Value::Null);
    }
    validate(
        &json!({"base_url":get("AEVORA_PROVIDER_BASE_URL"),"model":get("AEVORA_PROVIDER_MODEL"),
        "api_key":get("AEVORA_PROVIDER_API_KEY"),"chat_allowed":true,"max_input_tokens":4096,"max_output_tokens":512}),
        &Value::Null,
    )
}
