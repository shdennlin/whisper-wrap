//! LLM client for POST /ask (llm-provider-abstraction). An `LlmProvider`
//! trait fronts a Gemini implementation (the original REST client) and an
//! OpenAI-compatible implementation, selected by config — so any
//! OpenAI-compatible endpoint (Ollama, OpenRouter, a self-hosted LiteLLM
//! proxy, OpenAI) works without code changes. ASR + diarization stay
//! on-device; only the AI step goes to the user-configured endpoint.

use async_trait::async_trait;
use futures_util::stream::BoxStream;
use futures_util::StreamExt;
use serde_json::{json, Value};
use thiserror::Error;

pub const DEFAULT_GEMINI_MODEL: &str = "gemini-3.1-flash-lite";
pub const DEFAULT_OPENAI_MODEL: &str = "gpt-4o-mini";
pub const DEFAULT_SYSTEM_PROMPT: &str = "你是一個語音助理。使用者會用語音或文字向你提問，請以簡潔、自然、口語化的方式回答。預設使用台灣繁體中文回答，除非使用者明確使用其他語言。";

const GEMINI_API_BASE: &str = "https://generativelanguage.googleapis.com/v1beta/models";
/// Host shown in the privacy indicator for the Gemini provider.
const GEMINI_HOST: &str = "https://generativelanguage.googleapis.com";

#[derive(Debug, Error)]
pub enum LlmError {
    #[error("the AI provider is not configured")]
    NotConfigured,
    #[error("AI call failed: {0}")]
    Upstream(String),
}

/// One AI backend. Boxed behind `LlmClient`; the streams are boxed so both
/// providers unify behind one return type.
#[async_trait]
pub trait LlmProvider: Send + Sync {
    async fn ask(&self, user_text: &str, model: Option<&str>) -> Result<String, LlmError>;
    async fn ask_stream(
        &self,
        user_text: &str,
        model: Option<&str>,
    ) -> Result<BoxStream<'static, Result<String, LlmError>>, LlmError>;
    fn configured(&self) -> bool;
    fn default_model(&self) -> &str;
    fn provider_name(&self) -> &str;
    /// The endpoint a transcript would be sent to (privacy indicator). Never
    /// includes the key.
    fn endpoint(&self) -> &str;
}

fn resolve(raw: Option<&str>, default: &str, var: &str) -> String {
    match raw {
        None => default.to_owned(),
        Some("") => {
            log::warn!("{var} is set but empty — using default");
            default.to_owned()
        }
        Some(v) => v.to_owned(),
    }
}

// Bind IPv4 explicitly: hosts with a broken/half-configured IPv6 route hit
// "No route to host" when the resolver returns AAAA first (curl survives via
// happy-eyeballs; reqwest's pool does not).
fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .local_address(std::net::IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED))
        .build()
        .expect("reqwest client")
}

fn upstream(e: impl std::fmt::Display) -> LlmError {
    LlmError::Upstream(format!("{e}"))
}

/// The model for a call: a non-empty per-call override, else the default.
fn model_for<'a>(model_override: Option<&'a str>, default: &'a str) -> &'a str {
    model_override.filter(|m| !m.is_empty()).unwrap_or(default)
}

// ---------- Gemini ----------

pub struct GeminiProvider {
    api_key: Option<String>,
    model: String,
    system_prompt: String,
    http: reqwest::Client,
}

impl GeminiProvider {
    pub fn from_config(config: &whisper_wrap_core::Config) -> Self {
        GeminiProvider {
            api_key: config.gemini_api_key.clone().filter(|k| !k.is_empty()),
            model: resolve(
                config.gemini_model.as_deref(),
                DEFAULT_GEMINI_MODEL,
                "GEMINI_MODEL",
            ),
            system_prompt: resolve(
                config.gemini_system_prompt.as_deref(),
                DEFAULT_SYSTEM_PROMPT,
                "GEMINI_SYSTEM_PROMPT",
            ),
            http: http_client(),
        }
    }

    fn model_for(&self, model: Option<&str>) -> String {
        model_for(model, &self.model).to_owned()
    }

    fn body(&self, user_text: &str) -> Value {
        json!({
            "contents": [{"parts": [{"text": user_text}]}],
            "systemInstruction": {"parts": [{"text": self.system_prompt}]},
        })
    }

    fn key(&self) -> Result<&str, LlmError> {
        self.api_key.as_deref().ok_or(LlmError::NotConfigured)
    }
}

#[async_trait]
impl LlmProvider for GeminiProvider {
    async fn ask(&self, user_text: &str, model: Option<&str>) -> Result<String, LlmError> {
        let key = self.key()?;
        let url = format!(
            "{GEMINI_API_BASE}/{}:generateContent",
            self.model_for(model)
        );
        let resp = self
            .http
            .post(&url)
            .header("x-goog-api-key", key)
            .json(&self.body(user_text))
            .send()
            .await
            .map_err(upstream)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(LlmError::Upstream(format!("HTTP {status}: {text}")));
        }
        let v: Value = resp.json().await.map_err(upstream)?;
        Ok(gemini_text(&v))
    }

    async fn ask_stream(
        &self,
        user_text: &str,
        model: Option<&str>,
    ) -> Result<BoxStream<'static, Result<String, LlmError>>, LlmError> {
        let key = self.key()?;
        let url = format!(
            "{GEMINI_API_BASE}/{}:streamGenerateContent?alt=sse",
            self.model_for(model)
        );
        let resp = self
            .http
            .post(&url)
            .header("x-goog-api-key", key)
            .json(&self.body(user_text))
            .send()
            .await
            .map_err(upstream)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(LlmError::Upstream(format!("HTTP {status}: {text}")));
        }
        let stream = async_stream::try_stream! {
            let mut bytes = resp.bytes_stream();
            let mut buf = String::new();
            while let Some(chunk) = bytes.next().await {
                let chunk = chunk.map_err(upstream)?;
                // Gemini sends CRLF; normalize so the \n\n frame split matches.
                buf.push_str(&String::from_utf8_lossy(&chunk).replace('\r', ""));
                while let Some(pos) = buf.find("\n\n") {
                    let frame = buf[..pos].to_owned();
                    buf.drain(..pos + 2);
                    for line in frame.lines() {
                        if let Some(data) = line.strip_prefix("data: ") {
                            if data == "[DONE]" { continue; }
                            if let Ok(v) = serde_json::from_str::<Value>(data) {
                                let text = gemini_text(&v);
                                if !text.is_empty() { yield text; }
                            }
                        }
                    }
                }
            }
        };
        Ok(stream.boxed())
    }

    fn configured(&self) -> bool {
        self.api_key.is_some()
    }
    fn default_model(&self) -> &str {
        &self.model
    }
    fn provider_name(&self) -> &str {
        "gemini"
    }
    fn endpoint(&self) -> &str {
        GEMINI_HOST
    }
}

fn gemini_text(v: &Value) -> String {
    v["candidates"][0]["content"]["parts"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p["text"].as_str())
                .collect::<String>()
        })
        .unwrap_or_default()
}

// ---------- OpenAI-compatible ----------

pub struct OpenAiCompatProvider {
    api_key: Option<String>,
    base_url: String,
    model: String,
    system_prompt: String,
    http: reqwest::Client,
}

impl OpenAiCompatProvider {
    pub fn from_config(config: &whisper_wrap_core::Config) -> Self {
        OpenAiCompatProvider {
            api_key: config.llm_api_key.clone().filter(|k| !k.is_empty()),
            base_url: config
                .llm_base_url
                .clone()
                .unwrap_or_default()
                .trim_end_matches('/')
                .to_owned(),
            model: resolve(
                config.llm_model.as_deref(),
                DEFAULT_OPENAI_MODEL,
                "LLM_MODEL",
            ),
            system_prompt: resolve(
                config.gemini_system_prompt.as_deref(),
                DEFAULT_SYSTEM_PROMPT,
                "GEMINI_SYSTEM_PROMPT",
            ),
            http: http_client(),
        }
    }

    fn build_body(&self, user_text: &str, model: Option<&str>, stream: bool) -> Value {
        json!({
            "model": model_for(model, &self.model),
            "messages": [
                {"role": "system", "content": self.system_prompt},
                {"role": "user", "content": user_text},
            ],
            "stream": stream,
        })
    }
}

/// Attach bearer auth only when a non-empty key is present (keyless local
/// endpoints like Ollama need no Authorization header).
fn maybe_bearer(req: reqwest::RequestBuilder, key: Option<&str>) -> reqwest::RequestBuilder {
    match key.filter(|k| !k.is_empty()) {
        Some(k) => req.bearer_auth(k),
        None => req,
    }
}

#[async_trait]
impl LlmProvider for OpenAiCompatProvider {
    async fn ask(&self, user_text: &str, model: Option<&str>) -> Result<String, LlmError> {
        if self.base_url.is_empty() {
            return Err(LlmError::NotConfigured);
        }
        let req = self
            .http
            .post(format!("{}/chat/completions", self.base_url));
        let resp = maybe_bearer(req, self.api_key.as_deref())
            .json(&self.build_body(user_text, model, false))
            .send()
            .await
            .map_err(upstream)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(LlmError::Upstream(format!("HTTP {status}: {text}")));
        }
        let v: Value = resp.json().await.map_err(upstream)?;
        Ok(v["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or_default()
            .to_owned())
    }

    async fn ask_stream(
        &self,
        user_text: &str,
        model: Option<&str>,
    ) -> Result<BoxStream<'static, Result<String, LlmError>>, LlmError> {
        if self.base_url.is_empty() {
            return Err(LlmError::NotConfigured);
        }
        let req = self
            .http
            .post(format!("{}/chat/completions", self.base_url));
        let resp = maybe_bearer(req, self.api_key.as_deref())
            .json(&self.build_body(user_text, model, true))
            .send()
            .await
            .map_err(upstream)?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(LlmError::Upstream(format!("HTTP {status}: {text}")));
        }
        let stream = async_stream::try_stream! {
            let mut bytes = resp.bytes_stream();
            let mut buf = String::new();
            while let Some(chunk) = bytes.next().await {
                let chunk = chunk.map_err(upstream)?;
                buf.push_str(&String::from_utf8_lossy(&chunk).replace('\r', ""));
                while let Some(pos) = buf.find("\n\n") {
                    let frame = buf[..pos].to_owned();
                    buf.drain(..pos + 2);
                    for line in frame.lines() {
                        if let Some(data) = line.strip_prefix("data: ") {
                            if data == "[DONE]" { continue; }
                            if let Ok(v) = serde_json::from_str::<Value>(data) {
                                if let Some(delta) = v["choices"][0]["delta"]["content"].as_str() {
                                    if !delta.is_empty() { yield delta.to_owned(); }
                                }
                            }
                        }
                    }
                }
            }
        };
        Ok(stream.boxed())
    }

    fn configured(&self) -> bool {
        // Keyless gate (D6): a non-empty base URL is enough — local servers
        // (Ollama) need no key.
        !self.base_url.is_empty()
    }
    fn default_model(&self) -> &str {
        &self.model
    }
    fn provider_name(&self) -> &str {
        "openai-compatible"
    }
    fn endpoint(&self) -> &str {
        &self.base_url
    }
}

// ---------- SSRF guard ----------

/// Reject SSRF-prone targets in a user-submitted base URL before the server
/// issues an outbound request on the caller's behalf. The `/config/ai/*`
/// endpoints are unauthenticated and the server may bind `0.0.0.0`, so a
/// LAN peer could otherwise steer these requests at hosts it cannot reach
/// directly (cloud metadata, internal-only services).
///
/// Loopback and RFC1918 are intentionally ALLOWED — local (Ollama) and LAN
/// (self-hosted proxy) endpoints are first-class configs. Only the link-local /
/// cloud-metadata range is blocked: it is never a legitimate provider and is
/// the high-value SSRF target (`169.254.169.254` IMDS, IPv6 `fe80::/10`,
/// `fc00::/7`). Hostnames are resolved so a name pointing at a blocked address
/// cannot slip through.
pub async fn validate_outbound_url(raw: &str) -> Result<(), String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "base URL is not a valid URL".to_string())?;
    match url.scheme() {
        "http" | "https" => {}
        other => {
            return Err(format!(
                "unsupported URL scheme {other:?}; only http and https are allowed"
            ))
        }
    }
    let host = url
        .host_str()
        .ok_or_else(|| "base URL has no host".to_string())?;
    let addrs: Vec<std::net::IpAddr> = match host.parse::<std::net::IpAddr>() {
        Ok(ip) => vec![ip],
        Err(_) => {
            let port = url.port_or_known_default().unwrap_or(80);
            tokio::net::lookup_host((host, port))
                .await
                .map_err(|e| format!("cannot resolve host {host:?}: {e}"))?
                .map(|sa| sa.ip())
                .collect()
        }
    };
    if addrs.is_empty() {
        return Err(format!("host {host:?} did not resolve to any address"));
    }
    for ip in addrs {
        if is_blocked_ip(&ip) {
            return Err(format!(
                "host {host:?} resolves to a blocked address ({ip}); link-local / metadata targets are not allowed"
            ));
        }
    }
    Ok(())
}

/// True for the link-local / cloud-metadata range and the unspecified address.
/// Loopback and private (RFC1918) ranges are deliberately NOT blocked.
fn is_blocked_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_link_local() || v4.is_unspecified(),
        std::net::IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return mapped.is_link_local() || mapped.is_unspecified();
            }
            let s = v6.segments();
            let link_local = (s[0] & 0xffc0) == 0xfe80; // fe80::/10
            let unique_local = (s[0] & 0xfe00) == 0xfc00; // fc00::/7 (incl. IPv6 IMDS)
            v6.is_unspecified() || link_local || unique_local
        }
    }
}

// ---------- model discovery ----------

/// Map a provider's raw `/models` JSON to a list of model identifiers.
/// Gemini: `models[].name` with the `models/` prefix stripped.
/// OpenAI-compatible: `data[].id`.
fn parse_model_list(provider: &str, v: &Value) -> Vec<String> {
    match provider {
        "gemini" => v["models"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m["name"].as_str())
                    .map(|n| n.strip_prefix("models/").unwrap_or(n).to_owned())
                    .collect()
            })
            .unwrap_or_default(),
        // openai / openai-compatible and anything else OpenAI-shaped.
        _ => v["data"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m["id"].as_str())
                    .map(|s| s.to_owned())
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Discover available models for a SUBMITTED provider/base_url/key (not
/// necessarily the saved client), so the UI can list before saving (D7). Any
/// failure (no list API, network, auth) is returned as `Err(message)`; the
/// caller surfaces it as an empty list + error, never a 5xx.
pub async fn list_models(
    provider: &str,
    base_url: &str,
    api_key: &str,
) -> Result<Vec<String>, String> {
    let http = http_client();
    let canonical = if provider == "gemini" {
        "gemini"
    } else {
        "openai-compatible"
    };
    let resp = if canonical == "gemini" {
        if api_key.is_empty() {
            return Err("a Gemini API key is required to list models".into());
        }
        let url = format!("{GEMINI_HOST}/v1beta/models");
        http.get(&url)
            .header("x-goog-api-key", api_key)
            .send()
            .await
            .map_err(|e| e.to_string())?
    } else {
        let base = base_url.trim_end_matches('/');
        if base.is_empty() {
            return Err("a base URL is required to list models".into());
        }
        validate_outbound_url(base).await?;
        let req = http.get(format!("{base}/models"));
        maybe_bearer(req, Some(api_key))
            .send()
            .await
            .map_err(|e| e.to_string())?
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {text}"));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(parse_model_list(canonical, &v))
}

// ---------- client ----------

pub struct LlmClient {
    provider: Box<dyn LlmProvider>,
}

impl LlmClient {
    pub fn from_config(config: &whisper_wrap_core::Config) -> Self {
        let provider: Box<dyn LlmProvider> = match config.llm_provider.as_deref() {
            Some("openai") | Some("openai-compatible") => {
                Box::new(OpenAiCompatProvider::from_config(config))
            }
            // Default (incl. "gemini" / unset / empty): the back-compatible path.
            _ => Box::new(GeminiProvider::from_config(config)),
        };
        LlmClient { provider }
    }

    pub fn configured(&self) -> bool {
        self.provider.configured()
    }
    pub fn provider_name(&self) -> &str {
        self.provider.provider_name()
    }
    pub fn endpoint(&self) -> &str {
        self.provider.endpoint()
    }
    pub fn model(&self) -> &str {
        self.provider.default_model()
    }

    pub async fn ask(&self, user_text: &str, model: Option<&str>) -> Result<String, LlmError> {
        self.provider.ask(user_text, model).await
    }

    pub async fn ask_stream(
        &self,
        user_text: &str,
        model: Option<&str>,
    ) -> Result<BoxStream<'static, Result<String, LlmError>>, LlmError> {
        self.provider.ask_stream(user_text, model).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use whisper_wrap_core::Config;

    #[test]
    fn gemini_provider_identity_and_model_override() {
        let mut c = Config::from_env();
        c.llm_provider = Some("gemini".into());
        c.gemini_model = Some("gemini-x".into());
        let p = GeminiProvider::from_config(&c);
        assert_eq!(p.provider_name(), "gemini");
        assert_eq!(p.endpoint(), GEMINI_HOST);
        assert_eq!(p.default_model(), "gemini-x");
        assert_eq!(p.model_for(Some("override-m")), "override-m");
        assert_eq!(p.model_for(None), "gemini-x");
        assert_eq!(
            p.model_for(Some("")),
            "gemini-x",
            "empty override falls back to default"
        );
    }

    #[test]
    fn openai_provider_identity_and_body() {
        let mut c = Config::from_env();
        c.llm_base_url = Some("http://localhost:11434/v1/".into());
        c.llm_model = Some("llama3".into());
        let p = OpenAiCompatProvider::from_config(&c);
        assert_eq!(p.provider_name(), "openai-compatible");
        assert_eq!(
            p.endpoint(),
            "http://localhost:11434/v1",
            "trailing slash trimmed"
        );
        assert_eq!(p.default_model(), "llama3");

        let body = p.build_body("hi", Some("gpt-4o"), false);
        assert_eq!(body["model"], serde_json::json!("gpt-4o"));
        let msgs = body["messages"].as_array().expect("messages");
        assert_eq!(msgs[0]["role"], serde_json::json!("system"));
        assert_eq!(msgs[1]["role"], serde_json::json!("user"));
        assert_eq!(msgs[1]["content"], serde_json::json!("hi"));
        assert_eq!(
            p.build_body("hi", None, false)["model"],
            serde_json::json!("llama3")
        );
    }

    #[test]
    fn gemini_without_key_is_not_configured() {
        let mut c = Config::from_env();
        c.llm_provider = Some("gemini".into());
        c.gemini_api_key = None;
        let client = LlmClient::from_config(&c);
        assert!(!client.configured(), "gemini with no key -> not configured");

        c.gemini_api_key = Some("k".into());
        let client = LlmClient::from_config(&c);
        assert!(client.configured(), "gemini with a key -> configured");
    }

    #[test]
    fn openai_compatible_without_key_is_configured_when_base_url_set() {
        let mut c = Config::from_env();
        c.llm_provider = Some("openai-compatible".into());
        c.llm_base_url = Some("http://localhost:11434/v1".into());
        c.llm_api_key = None;
        let client = LlmClient::from_config(&c);
        assert!(
            client.configured(),
            "openai-compatible with base url and no key -> configured"
        );

        let mut empty = Config::from_env();
        empty.llm_provider = Some("openai-compatible".into());
        empty.llm_base_url = None;
        empty.llm_api_key = None;
        let client = LlmClient::from_config(&empty);
        assert!(
            !client.configured(),
            "openai-compatible with no base url -> not configured"
        );
    }

    #[test]
    fn list_models_maps_gemini_shape() {
        let body = serde_json::json!({
            "models": [
                {"name": "models/gemini-3.1-flash-lite"},
                {"name": "models/gemini-2.0-pro"},
                {"name": "no-prefix-model"},
            ]
        });
        let got = parse_model_list("gemini", &body);
        assert_eq!(
            got,
            vec![
                "gemini-3.1-flash-lite".to_string(),
                "gemini-2.0-pro".to_string(),
                "no-prefix-model".to_string(),
            ]
        );
    }

    #[test]
    fn list_models_maps_openai_shape() {
        let body = serde_json::json!({
            "data": [
                {"id": "gpt-4o-mini"},
                {"id": "llama3"},
            ]
        });
        let got = parse_model_list("openai-compatible", &body);
        assert_eq!(got, vec!["gpt-4o-mini".to_string(), "llama3".to_string()]);
    }

    #[test]
    fn ssrf_guard_blocks_metadata_allows_local() {
        use std::net::IpAddr;
        // Cloud-metadata / link-local IPv4 is blocked.
        assert!(is_blocked_ip(&"169.254.169.254".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip(&"169.254.0.1".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip(&"0.0.0.0".parse::<IpAddr>().unwrap()));
        // IPv6 link-local, ULA (incl. IPv6 IMDS), unspecified, and mapped v4.
        assert!(is_blocked_ip(&"fe80::1".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip(&"fd00:ec2::254".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip(&"::".parse::<IpAddr>().unwrap()));
        assert!(is_blocked_ip(
            &"::ffff:169.254.169.254".parse::<IpAddr>().unwrap()
        ));
        // Loopback and RFC1918 stay ALLOWED — Ollama / LAN proxies are valid.
        assert!(!is_blocked_ip(&"127.0.0.1".parse::<IpAddr>().unwrap()));
        assert!(!is_blocked_ip(&"::1".parse::<IpAddr>().unwrap()));
        assert!(!is_blocked_ip(&"192.168.1.10".parse::<IpAddr>().unwrap()));
        assert!(!is_blocked_ip(&"10.0.0.5".parse::<IpAddr>().unwrap()));
        assert!(!is_blocked_ip(&"8.8.8.8".parse::<IpAddr>().unwrap()));
    }

    #[tokio::test]
    async fn validate_outbound_url_rejects_bad_scheme_and_metadata() {
        // Non-http schemes rejected.
        assert!(validate_outbound_url("file:///etc/passwd").await.is_err());
        assert!(validate_outbound_url("gopher://127.0.0.1:70")
            .await
            .is_err());
        assert!(validate_outbound_url("not a url").await.is_err());
        // IP-literal metadata rejected (no DNS needed).
        assert!(
            validate_outbound_url("http://169.254.169.254/latest/meta-data")
                .await
                .is_err()
        );
        assert!(validate_outbound_url("http://[fe80::1]:8080")
            .await
            .is_err());
        // Loopback / LAN allowed (Ollama, self-hosted proxy).
        assert!(validate_outbound_url("http://127.0.0.1:11434/v1")
            .await
            .is_ok());
        assert!(validate_outbound_url("http://192.168.1.50:4000/v1")
            .await
            .is_ok());
        // Hostname resolution path: localhost resolves to loopback -> allowed
        // (no external network needed).
        assert!(validate_outbound_url("http://localhost:11434/v1")
            .await
            .is_ok());
    }

    #[test]
    fn from_config_selects_provider() {
        let mut c = Config::from_env();
        c.llm_provider = Some("openai".into());
        c.llm_base_url = Some("http://host:1234/v1".into());
        let client = LlmClient::from_config(&c);
        assert_eq!(client.provider_name(), "openai-compatible");
        assert_eq!(client.endpoint(), "http://host:1234/v1");

        let mut d = Config::from_env();
        d.llm_provider = None; // default -> gemini
        let client = LlmClient::from_config(&d);
        assert_eq!(client.provider_name(), "gemini");
        assert_eq!(client.endpoint(), GEMINI_HOST);
    }
}
