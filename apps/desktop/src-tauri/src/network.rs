//! Host-only Tavily credentials and bounded public HTTPS reads.
use reqwest::{blocking::Client, Url};
use serde_json::{json, Value};
use std::{
    fs,
    io::Read,
    net::{IpAddr, SocketAddr, ToSocketAddrs},
    path::{Path, PathBuf},
    time::Duration,
};

const SEARCH_URL: &str = "https://api.tavily.com/search";
const MAX_BYTES: u64 = 512 * 1024;

#[derive(Clone)]
pub struct Vault {
    path: PathBuf,
    value: Value,
}
impl Vault {
    pub fn load(root: &Path, data: &Path) -> Result<Self, String> {
        let path = data.join("search.dpapi");

        let value = if path.exists() {
            serde_json::from_slice(&crate::provider::crypt(
                &fs::read(&path).map_err(|_| "Search configuration unavailable")?,
                false,
            )?)
            .map_err(|_| "Invalid search configuration")?
        } else {
            let mut key = String::new();
            #[cfg(debug_assertions)]
            {
                if let Ok(text) = fs::read_to_string(root.join(".env")) {
                    for line in text.trim_start_matches('\u{feff}').lines() {
                        if let Some((name, value)) = line.trim().split_once('=') {
                            if name.trim() == "AEVORA_TAVILY_API_KEY" {
                                key = value.trim().trim_matches(['\'', '"']).to_string();
                            }
                        }
                    }
                }
            }
            json!({"api_key":key,"allowed":false,"revision":0})
        };
        let mut vault = Self { path, value };
        // Persist imported credentials only as current-user DPAPI ciphertext.
        if !vault.path.exists() && vault.value["api_key"].as_str().unwrap_or("") != "" {
            vault.save(vault.value.clone())?;
        }
        Ok(vault)
    }
    fn save(&mut self, value: Value) -> Result<(), String> {
        let tmp = self.path.with_extension("tmp");
        let bytes = crate::provider::crypt(
            &serde_json::to_vec(&value).map_err(|_| "Invalid search config")?,
            true,
        )?;
        fs::write(&tmp, bytes).map_err(|_| "Cannot persist search credential")?;
        fs::rename(tmp, &self.path).map_err(|_| "Cannot replace search credential")?;
        self.value = value;
        Ok(())
    }
    pub fn public(&self) -> Value {
        json!({"service":"Tavily Search","endpoint":SEARCH_URL,"allowed":self.value["allowed"],"revision":self.value["revision"],
            "credential_present":!self.value["api_key"].as_str().unwrap_or("").is_empty()})
    }
    pub fn configure(&mut self, command: &Value) -> Result<Value, String> {
        let id = command["command_id"].as_str().unwrap_or("test");
        if let Some(old) = self.value["results"].get(id) {
            if old["request"] != *command {
                return Err("Search command ID reused".into());
            }
            return Ok(old["response"].clone());
        }
        if command["expected_revision"] != self.value["revision"] {
            return Err("Search revision changed; reload configuration".into());
        }
        let allowed = command["payload"]["allowed"]
            .as_bool()
            .ok_or("Explicit search purpose required")?;
        let supplied = command["payload"]["api_key"].as_str().unwrap_or("");
        let key = if supplied.is_empty() {
            self.value["api_key"].as_str().unwrap_or("")
        } else {
            supplied
        };
        if key.len() > 1000 || (allowed && key.is_empty()) {
            return Err("Search credential required".into());
        }
        let mut next = self.value.clone();
        next["api_key"] = json!(key);
        next["allowed"] = json!(allowed);
        next["revision"] = json!(self.value["revision"].as_u64().unwrap_or(0) + 1);
        let response = json!({"service":"Tavily Search","endpoint":SEARCH_URL,"allowed":allowed,"revision":next["revision"],"credential_present":!key.is_empty()});
        if next.get("results").is_none() {
            next["results"] = json!({});
        }
        next["results"][id] = json!({"request":command,"response":response});
        self.save(next)?;
        Ok(self.public())
    }
    pub fn check(&self, revision: &Value) -> Result<(), String> {
        if self.value["allowed"] != true
            || revision != &self.value["revision"]
            || self.value["api_key"].as_str().unwrap_or("").is_empty()
        {
            return Err(
                "Search purpose revoked or configuration changed; authorize a new task".into(),
            );
        }
        Ok(())
    }
    pub fn search(&self, query: &str, revision: &Value) -> Result<Value, String> {
        self.check(revision)?;
        if query.trim().is_empty() || query.chars().count() > 400 {
            return Err("Invalid approved query".into());
        }
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| "Search transport unavailable")?;
        let response = client.post(SEARCH_URL).bearer_auth(self.value["api_key"].as_str().unwrap())
            .json(&json!({"query":query,"search_depth":"basic","max_results":5,"auto_parameters":false,
                "include_answer":false,"include_raw_content":false,"include_usage":true,"include_images":false})).send().map_err(|_| "SearchTransportFailed")?;
        if !response.status().is_success() {
            return Err(format!("SearchHttp{}", response.status().as_u16()));
        }
        let bytes = bounded(response)?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| "InvalidSearchResponse")?;
        if !value["results"].is_array() || value["results"].as_array().unwrap().len() > 5 {
            return Err("InvalidSearchResponse".into());
        }
        let mut results = Vec::new();
        for item in value["results"].as_array().unwrap() {
            let url = item["url"].as_str().ok_or("InvalidSearchResponse")?;
            // Unsafe/non-HTTPS search results are visible as excluded, never fetched.
            if valid_url(url).is_err() {
                continue;
            }
            let title = item["title"].as_str().ok_or("InvalidSearchResponse")?;
            let content = item["content"].as_str().ok_or("InvalidSearchResponse")?;
            results.push(json!({"url":url,"title":title,"snippet":content}));
        }
        Ok(
            json!({"query":query,"results":results,"request_id":value["request_id"],"usage":value["usage"],
            "excluded_results":value["results"].as_array().unwrap().len()-results.len(),"raw_response":value}),
        )
    }
}

pub fn valid_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "InvalidPublicUrl")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().map(|p| p != 443).unwrap_or(false)
        || url.host_str().is_none()
    {
        return Err("PublicHttpsUrlRequired".into());
    }
    let host = url.host_str().unwrap().trim_matches(['[', ']']);
    if host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || !host.contains('.') && !host.contains(':')
    {
        return Err("LocalDestinationForbidden".into());
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        if !public_ip(ip) {
            return Err("LocalDestinationForbidden".into());
        }
    }
    Ok(url)
}
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && (b == 168 || b == 0 || b == 2))
                || (a == 100 && (64..=127).contains(&b))
                || (a == 198 && (b == 18 || b == 19 || b == 51 && c == 100))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(v4));
            }
            let s = ip.segments();
            !ip.is_loopback()
                && !ip.is_unspecified()
                && (s[0] & 0xe000 == 0x2000)
                && s[0] != 0x2002
                && !(s[0] == 0x2001 && (s[1] == 0x0db8 || s[1] < 0x200))
        }
    }
}
fn bounded(response: reqwest::blocking::Response) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .map(|n| n > MAX_BYTES)
        .unwrap_or(false)
    {
        return Err("SourceCapacity".into());
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "SourceTransportFailed")?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("SourceCapacity".into());
    }
    Ok(bytes)
}
pub(crate) fn redirect_needs_review(original_host: &str, next: &Url, approved: &[String]) -> bool {
    next.host_str() != Some(original_host)
        && !approved.iter().any(|h| Some(h.as_str()) == next.host_str())
}
pub fn fetch(value: &str, redirect_hosts: &[String]) -> Result<Value, String> {
    let original = valid_url(value)?;
    let mut url = original.clone();
    for hop in 0..=3 {
        valid_url(url.as_str())?;
        let host = url.host_str().unwrap().trim_matches(['[', ']']);
        let addresses: Vec<SocketAddr> = (host, 443)
            .to_socket_addrs()
            .map_err(|_| "SourceDnsFailed")?
            .collect();
        if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
            return Err("LocalDestinationForbidden".into());
        }
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(20))
            .resolve_to_addrs(host, &addresses)
            .build()
            .map_err(|_| "SourceTransportFailed")?;
        let response = client
            .get(url.clone())
            .header("Accept", "text/html,text/plain,text/markdown")
            .header("User-Agent", "Aevora/0.1 public-source-reader")
            .send()
            .map_err(|_| "SourceTransportFailed")?;
        if response.status().is_redirection() {
            if hop == 3 {
                return Err("RedirectLimit".into());
            }
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|h| h.to_str().ok())
                .ok_or("InvalidRedirect")?;
            let next = url.join(location).map_err(|_| "InvalidRedirect")?;
            valid_url(next.as_str())?;
            if redirect_needs_review(original.host_str().unwrap(), &next, redirect_hosts) {
                return Ok(
                    json!({"status":"RedirectApprovalRequired","original_url":value,"redirect_url":next.as_str(),"http_requests_started":hop+1}),
                );
            }
            url = next;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("SourceHttp{}", response.status().as_u16()));
        }
        if response.status().as_u16() == 206
            || response
                .headers()
                .contains_key(reqwest::header::CONTENT_RANGE)
        {
            return Err("PartialSourceUnsupported".into());
        }
        let http_status = response.status().as_u16();
        let header = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_lowercase();
        let content_type = header.split(';').next().unwrap_or("").trim().to_string();
        if !matches!(
            content_type.as_str(),
            "text/html" | "text/plain" | "text/markdown"
        ) {
            return Err("UnsupportedSource".into());
        }
        if let Some(charset) = header.split("charset=").nth(1) {
            let charset = charset.split(';').next().unwrap().trim().trim_matches('"');
            if !matches!(charset, "utf-8" | "utf8" | "us-ascii") {
                return Err("UnsupportedSourceEncoding".into());
            }
        }
        let body =
            String::from_utf8(bounded(response)?).map_err(|_| "UnsupportedSourceEncoding")?;
        return Ok(
            json!({"original_url":value,"final_url":url.as_str(),"content_type":content_type,"http_status":http_status,"body":body.trim_start_matches('\u{feff}'),
            "http_requests_started":hop+1,"fetched_at":std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| "ClockError")?.as_secs()}),
        );
    }
    Err("RedirectLimit".into())
}
