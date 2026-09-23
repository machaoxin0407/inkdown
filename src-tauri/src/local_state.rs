use crate::{display, err, markdown, Access};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{Manager, State};

#[derive(Default)]
pub struct LocalState {
    lock: Mutex<()>,
    index: AtomicU64,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub path: String,
    pub edit: bool,
    pub line: f64,
    pub progress: f64,
    pub at_start: bool,
    pub at_end: bool,
    pub cursor: usize,
    pub editor_line: usize,
    pub updated_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub version: u32,
    pub id: String,
    pub name: String,
    pub path: String,
    pub content: String,
    pub fingerprint: String,
    pub bom: bool,
    pub newline: String,
    pub position: Position,
    pub updated_at: u64,
}
#[derive(Serialize)]
pub struct DraftList {
    drafts: Vec<Draft>,
    warnings: Vec<String>,
}
fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // Explicit override allows isolated portable/test profiles; never supplied over IPC.
    let p = std::env::var_os("INKDOWN_DATA_DIR")
        .map(PathBuf::from)
        .map(Ok)
        .unwrap_or_else(|| app.path().app_local_data_dir().map_err(err))?;
    fs::create_dir_all(p.join("drafts")).map_err(err)?;
    Ok(p)
}
fn draft_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("无效草稿标识".into());
    }
    Ok(root.join("drafts").join(format!("{}.json", id)))
}
fn atomic_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let mut f = tempfile::NamedTempFile::new_in(path.parent().ok_or("无效目录")?).map_err(err)?;
    serde_json::to_writer(&mut f, value).map_err(err)?;
    f.flush().map_err(err)?;
    f.as_file().sync_all().map_err(err)?;
    f.persist(path).map_err(err)?;
    Ok(())
}
fn load_drafts(root: &Path) -> Result<DraftList, String> {
    let mut result = DraftList {
        drafts: vec![],
        warnings: vec![],
    };
    for entry in fs::read_dir(root.join("drafts")).map_err(err)? {
        let entry = entry.map_err(err)?;
        if entry.path().extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let draft = fs::read(entry.path())
            .map_err(err)
            .and_then(|v| serde_json::from_slice::<Draft>(&v).map_err(err));
        match draft {
            Ok(d)
                if d.version == 1
                    && draft_path(root, &d.id).ok().as_ref() == Some(&entry.path()) =>
            {
                result.drafts.push(d)
            }
            _ => result.warnings.push(format!(
                "草稿 {} 无法读取，已保留原备份",
                entry.file_name().to_string_lossy()
            )),
        }
    }
    result
        .drafts
        .sort_by_key(|d| std::cmp::Reverse(d.updated_at));
    Ok(result)
}
#[tauri::command]
pub fn list_drafts(app: tauri::AppHandle, state: State<LocalState>) -> Result<DraftList, String> {
    let _guard = state.lock.lock().map_err(err)?;
    load_drafts(&root(&app)?)
}
#[tauri::command]
pub fn write_draft(
    app: tauri::AppHandle,
    state: State<LocalState>,
    draft: Draft,
) -> Result<(), String> {
    let _guard = state.lock.lock().map_err(err)?;
    if draft.version != 1 || draft.content.len() > 32 * 1024 * 1024 {
        return Err("草稿超过支持范围".into());
    }
    atomic_json(&draft_path(&root(&app)?, &draft.id)?, &draft)
}
#[tauri::command]
pub fn delete_draft(
    app: tauri::AppHandle,
    state: State<LocalState>,
    id: String,
) -> Result<(), String> {
    let _guard = state.lock.lock().map_err(err)?;
    match fs::remove_file(draft_path(&root(&app)?, &id)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(err(e)),
    }
}
#[derive(Serialize, Deserialize)]
struct Positions {
    version: u32,
    positions: Vec<Position>,
}
fn positions(root: &Path) -> Result<Vec<Position>, String> {
    match fs::read(root.join("positions.json")) {
        Ok(v) => {
            let data: Positions = serde_json::from_slice(&v).map_err(err)?;
            if data.version != 1 {
                return Err("不支持的位置记录版本".into());
            }
            Ok(data.positions)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(err(e)),
    }
}
fn put_position(root: &Path, position: Position) -> Result<(), String> {
    let mut all = positions(root)?;
    all.retain(|p| !p.path.eq_ignore_ascii_case(&position.path));
    all.push(position);
    all.sort_by_key(|p| std::cmp::Reverse(p.updated_at));
    all.truncate(200);
    atomic_json(
        &root.join("positions.json"),
        &Positions {
            version: 1,
            positions: all,
        },
    )
}
#[tauri::command]
pub fn read_positions(
    app: tauri::AppHandle,
    state: State<LocalState>,
) -> Result<Vec<Position>, String> {
    let _g = state.lock.lock().map_err(err)?;
    positions(&root(&app)?)
}
#[tauri::command]
pub fn write_position(
    app: tauri::AppHandle,
    state: State<LocalState>,
    position: Position,
) -> Result<(), String> {
    let _g = state.lock.lock().map_err(err)?;
    put_position(&root(&app)?, position)
}
#[derive(Serialize)]
pub struct IndexResult {
    paths: Vec<String>,
    skipped: usize,
    cancelled: bool,
}
fn scan(root: PathBuf, valid: impl Fn() -> bool) -> IndexResult {
    let mut out = IndexResult {
        paths: vec![],
        skipped: 0,
        cancelled: false,
    };
    let mut dirs = vec![root];
    while let Some(dir) = dirs.pop() {
        if !valid() {
            out.cancelled = true;
            break;
        }
        let entries = match fs::read_dir(dir) {
            Ok(v) => v,
            Err(_) => {
                out.skipped += 1;
                continue;
            }
        };
        for item in entries {
            if !valid() {
                out.cancelled = true;
                return out;
            }
            let item = match item {
                Ok(v) => v,
                Err(_) => {
                    out.skipped += 1;
                    continue;
                }
            };
            let name = item.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || matches!(name.as_str(), "node_modules" | "target" | "dist")
            {
                continue;
            }
            let kind = match item.file_type() {
                Ok(v) => v,
                Err(_) => {
                    out.skipped += 1;
                    continue;
                }
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                dirs.push(item.path());
            } else if kind.is_file() && markdown(&item.path()) {
                out.paths.push(display(&item.path()));
            }
        }
    }
    out.paths.sort();
    out
}
#[tauri::command]
pub fn cancel_index(state: State<LocalState>) {
    state.index.fetch_add(1, Ordering::SeqCst);
}
#[tauri::command]
pub async fn index_workspace(app: tauri::AppHandle, path: String) -> Result<IndexResult, String> {
    let root = fs::canonicalize(path).map_err(err)?;
    if !app
        .state::<Access>()
        .roots
        .lock()
        .map_err(err)?
        .contains(&root)
    {
        return Err("请先打开此工作区".into());
    }
    let ticket = app
        .state::<LocalState>()
        .index
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    tauri::async_runtime::spawn_blocking(move || {
        scan(root, || {
            app.state::<LocalState>().index.load(Ordering::SeqCst) == ticket
        })
    })
    .await
    .map_err(err)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn pos(path: String, n: u64) -> Position {
        Position {
            path,
            edit: false,
            line: 0.,
            progress: 0.,
            at_start: true,
            at_end: false,
            cursor: 0,
            editor_line: 0,
            updated_at: n,
        }
    }
    #[test]
    fn safe_ids_and_corrupt_drafts() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir(d.path().join("drafts")).unwrap();
        assert!(draft_path(d.path(), "../bad").is_err());
        fs::write(d.path().join("drafts/bad.json"), "broken").unwrap();
        assert_eq!(load_drafts(d.path()).unwrap().warnings.len(), 1);
    }
    #[test]
    fn position_limit_and_replace() {
        let d = tempfile::tempdir().unwrap();
        for n in 0..205 {
            put_position(d.path(), pos(format!("C:/{}.md", n), n)).unwrap();
        }
        put_position(d.path(), pos("c:/204.MD".into(), 999)).unwrap();
        let all = positions(d.path()).unwrap();
        assert_eq!(all.len(), 200);
        assert_eq!(all[0].updated_at, 999);
    }
    #[test]
    fn index_exclusions_and_cancel() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir(d.path().join("node_modules")).unwrap();
        fs::write(d.path().join("node_modules/hide.md"), "").unwrap();
        fs::write(d.path().join("中文.md"), "").unwrap();
        fs::write(d.path().join("x.txt"), "").unwrap();
        assert_eq!(scan(d.path().into(), || true).paths.len(), 1);
        assert!(scan(d.path().into(), || false).cancelled);
    }
}
