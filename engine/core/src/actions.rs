//! Prompt-action templates — port of `app/services/actions.py`.
//! Loads `registry/actions.yaml`. Policy (matches v2): missing or
//! malformed file → WARN + empty list (server starts); duplicate id
//! or a template missing the `{transcript}` placeholder → hard error
//! (server refuses to start).

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ActionsError {
    #[error("duplicate action id {0:?}")]
    DuplicateId(String),
    #[error("action {0:?} template is missing the {{transcript}} placeholder")]
    MissingPlaceholder(String),
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum LabelOrMap {
    Single(String),
    Map(BTreeMap<String, String>),
}

impl LabelOrMap {
    fn into_map(self) -> BTreeMap<String, String> {
        match self {
            LabelOrMap::Single(s) => BTreeMap::from([("en".to_owned(), s)]),
            LabelOrMap::Map(m) => m,
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawAction {
    id: String,
    label: LabelOrMap,
    template: String,
    category: Option<String>,
    description: Option<LabelOrMap>,
}

#[derive(Debug, Deserialize)]
struct RawCategory {
    id: String,
    label: LabelOrMap,
}

#[derive(Debug, Deserialize)]
struct RawFile {
    #[serde(default)]
    categories: Vec<RawCategory>,
    #[serde(default)]
    actions: Vec<RawAction>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Action {
    pub id: String,
    pub label: String,
    pub labels: BTreeMap<String, String>,
    pub template: String,
    pub category: Option<String>,
    #[serde(rename = "categoryLabels")]
    pub category_labels: Option<BTreeMap<String, String>>,
    pub description: Option<String>,
    #[serde(rename = "descriptionLabels")]
    pub description_labels: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Category {
    pub id: String,
    pub label: String,
    pub labels: BTreeMap<String, String>,
}

fn legacy_label(map: &BTreeMap<String, String>) -> String {
    map.get("en")
        .or_else(|| map.values().next())
        .cloned()
        .unwrap_or_default()
}

/// Load + validate. Missing/malformed file → WARN + empty (Ok);
/// semantic violations → Err.
pub fn load_actions(path: &Path) -> Result<(Vec<Action>, Vec<Category>), ActionsError> {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("actions registry {path:?} not readable ({e}); serving empty list");
            return Ok((Vec::new(), Vec::new()));
        }
    };
    let parsed: RawFile = match serde_yaml::from_str(&raw) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("actions registry {path:?} malformed ({e}); serving empty list");
            return Ok((Vec::new(), Vec::new()));
        }
    };

    let categories: Vec<Category> = parsed
        .categories
        .into_iter()
        .map(|c| {
            let labels = c.label.into_map();
            Category {
                id: c.id,
                label: legacy_label(&labels),
                labels,
            }
        })
        .collect();

    let mut seen = std::collections::HashSet::new();
    let mut actions = Vec::new();
    for a in parsed.actions {
        if !seen.insert(a.id.clone()) {
            return Err(ActionsError::DuplicateId(a.id));
        }
        if !a.template.contains("{transcript}") {
            return Err(ActionsError::MissingPlaceholder(a.id));
        }
        if let Some(cat) = &a.category {
            if !categories.iter().any(|c| &c.id == cat) {
                log::warn!("action {:?} references unknown category {cat:?}", a.id);
            }
        }
        let labels = a.label.into_map();
        let desc_labels = a.description.map(LabelOrMap::into_map);
        actions.push(Action {
            id: a.id,
            label: legacy_label(&labels),
            labels,
            template: a.template,
            category: a.category,
            category_labels: None, // shipped yaml uses string-form categories
            description: desc_labels.as_ref().map(legacy_label),
            description_labels: desc_labels,
        });
    }
    Ok((actions, categories))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_tmp(content: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let p = std::env::temp_dir().join(format!(
            "actions-test-{}-{}.yaml",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        p
    }

    #[test]
    fn parses_shipped_shape() {
        let p = write_tmp(
            "categories:\n  - id: raw\n    label:\n      en: Raw\n      zh-TW: 原文\nactions:\n  - id: send\n    label:\n      en: Send\n      zh-TW: 直接送\n    category: raw\n    template: \"{transcript}\"\n",
        );
        let (actions, cats) = load_actions(&p).unwrap();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].label, "Send");
        assert_eq!(actions[0].labels["zh-TW"], "直接送");
        assert_eq!(cats[0].id, "raw");
        std::fs::remove_file(p).ok();
    }

    #[test]
    fn missing_file_is_empty_not_error() {
        let (a, c) = load_actions(Path::new("/nonexistent/actions.yaml")).unwrap();
        assert!(a.is_empty() && c.is_empty());
    }

    #[test]
    fn duplicate_id_and_missing_placeholder_are_hard_errors() {
        let p = write_tmp("actions:\n  - id: a\n    label: A\n    template: \"x\"\n");
        assert!(matches!(
            load_actions(&p),
            Err(ActionsError::MissingPlaceholder(_))
        ));
        std::fs::remove_file(p).ok();

        let p = write_tmp(
            "actions:\n  - id: a\n    label: A\n    template: \"{transcript}\"\n  - id: a\n    label: B\n    template: \"{transcript}\"\n",
        );
        assert!(matches!(
            load_actions(&p),
            Err(ActionsError::DuplicateId(_))
        ));
        std::fs::remove_file(p).ok();
    }
}
