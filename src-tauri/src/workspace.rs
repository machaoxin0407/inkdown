use crate::{display, err, markdown, Access};
use notify::{RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use std::{collections::{HashSet, HashMap}, fs, path::{Path, PathBuf}, sync::{atomic::{AtomicU64, Ordering}, Arc}, time::Duration};
use tauri::{Emitter, Manager, State};

#[derive(Default)]
pub struct WorkspaceState { generation: Arc<AtomicU64>, search: AtomicU64 }
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Changes { generation: u64, paths: Vec<String>, structural: bool, failed: bool }
fn excluded(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root).unwrap_or(path).components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        s.starts_with('.') || matches!(s.as_ref(), "node_modules" | "target" | "dist")
    })
}
fn allowed(app: &tauri::AppHandle, p: &Path) -> bool {
    let access = app.state::<Access>();
    access.roots.lock().map(|r| r.iter().any(|r| p.starts_with(r))).unwrap_or(false)
        || access.documents.lock().map(|d| d.contains(p)).unwrap_or(false)
}
#[tauri::command]
pub fn watch_paths(app: tauri::AppHandle, workspace: String, paths: Vec<String>, generation: u64, extra_roots: Option<Vec<String>>) -> Result<(), String> {
    let epoch = app.state::<WorkspaceState>().generation.clone();
    let ticket = epoch.fetch_add(1, Ordering::SeqCst) + 1;
    let root = if workspace.is_empty() { None } else { Some(fs::canonicalize(workspace).map_err(err)?) };
    let mut roots = Vec::new();
    if let Some(r) = &root {
        if !allowed(&app, r) { return Err("请先打开工作区".into()); }
        roots.push((r.clone(), RecursiveMode::Recursive));
    }
    for extra in extra_roots.unwrap_or_default() {
        let p=fs::canonicalize(extra).map_err(err)?;
        if !allowed(&app,&p) {return Err("请先打开笔记库".into())}
        if !roots.iter().any(|(r,_)|p.starts_with(r)){roots.push((p,RecursiveMode::Recursive));}
    }
    for path in paths {
        let raw = PathBuf::from(path);
        let p = fs::canonicalize(&raw).unwrap_or(raw);
        if !allowed(&app, &p) { continue; }
        if root.as_ref().is_some_and(|r| p.starts_with(r)) { continue; }
        if let Some(parent) = p.parent() {
            if !roots.iter().any(|(r, _)| r == parent) { roots.push((parent.to_owned(), RecursiveMode::NonRecursive)); }
        }
    }
    let (tx, rx) = std::sync::mpsc::channel();
    let mut watcher = notify::RecommendedWatcher::new(move |event| { let _ = tx.send(event); }, notify::Config::default().with_follow_symlinks(false)).map_err(err)?;
    for (path, mode) in &roots { watcher.watch(path, *mode).map_err(err)?; }
    std::thread::spawn(move || {
        let _watcher = watcher;
        while epoch.load(Ordering::SeqCst) == ticket {
            let first = match rx.recv_timeout(Duration::from_millis(300)) { Ok(v) => v, Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue, Err(_) => break };
            let mut events = vec![first];
            std::thread::sleep(Duration::from_millis(300));
            events.extend(rx.try_iter());
            let mut changed = HashSet::new(); let mut failed = false; let mut structural = false;
            for event in events {
                match event {
                    Ok(event) => {
                        if matches!(event.kind, notify::EventKind::Access(_)) { continue; }
                        structural |= matches!(event.kind, notify::EventKind::Any | notify::EventKind::Other | notify::EventKind::Create(notify::event::CreateKind::Any) | notify::EventKind::Remove(notify::event::RemoveKind::Any) | notify::EventKind::Modify(notify::event::ModifyKind::Any) | notify::EventKind::Create(notify::event::CreateKind::Folder) | notify::EventKind::Remove(notify::event::RemoveKind::Folder) | notify::EventKind::Modify(notify::event::ModifyKind::Name(_)));
                        structural |= event.paths.iter().any(|p| !markdown(p) && !p.extension().is_some());
                        for p in event.paths {
                            if roots.iter().any(|(r, _)| p.starts_with(r) && !excluded(r, &p)) { changed.insert(display(&p)); }
                        }
                    },
                    Err(_) => failed = true,
                }
            }
            if epoch.load(Ordering::SeqCst) == ticket && (!changed.is_empty() || failed) {
                let _ = app.emit("workspace-changed", Changes { generation, paths: changed.into_iter().collect(), structural, failed });
            }
        }
    });
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overlay { path: String, content: String, #[serde(default)] source_version: String }
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Hit { path: String, line: usize, from: usize, to: usize, snippet: String, source_version: String, query: String, sensitive: bool }
#[derive(Serialize)]
pub struct SearchResult { hits: Vec<Hit>, skipped: usize, truncated: bool, cancelled: bool }
#[tauri::command]
pub fn cancel_search(state: State<WorkspaceState>) { state.search.fetch_add(1, Ordering::SeqCst); }
fn find_matches(path: &str, content: &str, expression: &regex::Regex, query: &str, sensitive: bool, version: &str, hits: &mut Vec<Hit>, cancelled: impl Fn() -> bool) -> bool {
    let mut offset = 0;
    let overlap = query.chars().count().saturating_mul(4).max(4);
    for (line, value) in content.split('\n').enumerate() {
        if cancelled() { return true; }
        let mut start = 0; let mut previous = 0; let mut units = 0;
        while start < value.len() {
            if cancelled() { return true; }
            let mut end = value.len().min(start.saturating_add(65536));
            while !value.is_char_boundary(end) { end -= 1; }
            let mut scan_end = value.len().min(end.saturating_add(overlap));
            while !value.is_char_boundary(scan_end) { scan_end += 1; }
            let mut consumed = start;
            for found in expression.find_iter(&value[start..scan_end]) {
                if cancelled() { return true; }
                let from = start + found.start(); let to = start + found.end();
                if from >= end { break; }
                if hits.len() >= 501 { return false; }
                units += value[previous..from].encode_utf16().count();
                let length = value[from..to].encode_utf16().count();
                let before: String = value[..from].chars().rev().take(50).collect::<Vec<_>>().into_iter().rev().collect();
                let snippet = before + &value[from..].chars().take(130).collect::<String>();
                hits.push(Hit { path:path.into(), line:line+1, from:offset+units, to:offset+units+length, snippet,
                    source_version:version.into(), query:query.into(), sensitive });
                units += length; previous = to; consumed = to;
            }
            start = end.max(consumed);
            units += value[previous..start].encode_utf16().count(); previous = start;
        }
        offset += units + 1;
    }
    false
}

#[cfg(test)]
fn matches(path: &str, content: &str, query: &str, sensitive: bool, hits: &mut Vec<Hit>) {
    let expression = regex::RegexBuilder::new(&regex::escape(query)).case_insensitive(!sensitive).build().unwrap();
    find_matches(path,content,&expression,query,sensitive,"test",hits,||false);
}
fn search_content(p: &Path, overlays: &HashMap<String, Overlay>) -> Result<(String, String), String> {
    let key = display(p).replace('\\', "/").to_lowercase();
    if let Some(o) = overlays.get(&key) { return Ok((o.content.clone(), o.source_version.clone())); }
    crate::read(p).map(|d| (d.content, d.fingerprint))
}
#[tauri::command]
pub async fn search_workspace(app: tauri::AppHandle, path: String, query: String, sensitive: bool, overlays: Vec<Overlay>) -> Result<SearchResult, String> {
    let root = fs::canonicalize(path).map_err(err)?;
    if !allowed(&app, &root) { return Err("请先打开工作区".into()); }
    let ticket = app.state::<WorkspaceState>().search.fetch_add(1, Ordering::SeqCst) + 1;
    let expression = regex::RegexBuilder::new(&regex::escape(&query)).case_insensitive(!sensitive).build().map_err(err)?;
    let overlays: HashMap<_,_> = overlays.into_iter().map(|o| (o.path.replace('\\', "/").to_lowercase(), o)).collect();
    tauri::async_runtime::spawn_blocking(move || {
        let cancelled = || app.state::<WorkspaceState>().search.load(Ordering::SeqCst) != ticket;
        let mut result = SearchResult { hits: vec![], skipped: 0, truncated: false, cancelled: false };
        if query.is_empty() { return result; }
        let mut dirs = vec![root.clone()];
        while let Some(dir) = dirs.pop() {
            if cancelled() { result.cancelled = true; return result; }
            let entries = match fs::read_dir(dir) { Ok(v) => v, Err(_) => { result.skipped += 1; continue; } };
            for entry in entries {
                if cancelled() { result.cancelled = true; return result; }
                let entry = match entry { Ok(v) => v, Err(_) => { result.skipped += 1; continue; } };
                let p = entry.path();
                if excluded(&root, &p) { continue; }
                let kind = match entry.file_type() { Ok(v) => v, Err(_) => { result.skipped += 1; continue; } };
                if kind.is_symlink() { continue; }
                if kind.is_dir() { dirs.push(p); continue; }
                if !kind.is_file() || !markdown(&p) { continue; }
                match search_content(&p, &overlays) {
                    Ok((content,version)) => if find_matches(&display(&p), &content, &expression, &query, sensitive, &version, &mut result.hits, cancelled) { result.cancelled = true; return result; },
                    Err(_) => result.skipped += 1,
                }
                if result.hits.len() > 500 { result.hits.truncate(500); result.truncated = true; return result; }
            }
        }
        result
    }).await.map_err(err)
}
#[tauri::command]
pub async fn search_document(app: tauri::AppHandle, path: String, query: String, sensitive: bool, overlay: Option<Overlay>) -> Result<Vec<Hit>, String> {
    let p = fs::canonicalize(path).map_err(err)?;
    if !allowed(&app, &p) { return Err("请先打开文档".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let mut overlays = HashMap::new();
        if let Some(o) = overlay { overlays.insert(display(&p).replace('\\', "/").to_lowercase(), o); }
        let (content,version) = search_content(&p, &overlays)?;
        let expression = regex::RegexBuilder::new(&regex::escape(&query)).case_insensitive(!sensitive).build().map_err(err)?;
        let mut hits = Vec::new();
        if !query.is_empty() { find_matches(&display(&p), &content, &expression, &query, sensitive, &version, &mut hits, ||false); }
        hits.truncate(500);
        Ok(hits)
    }).await.map_err(err)?
}

fn valid_name(name: &str) -> bool {
    !name.is_empty() && !name.ends_with(['.', ' ']) && !name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) && !name.chars().any(|c| c.is_control()) && name != "." && name != ".."
}
pub(crate) fn rename_no_replace(source: &Path, target: &Path) -> Result<(), String> {
    #[cfg(windows)] {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" { fn MoveFileW(source: *const u16, target: *const u16) -> i32; }
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        // Unlike std::fs::rename / MoveFileEx(REPLACE_EXISTING), this also
        // rejects a destination created after the caller's existence check.
        if unsafe { MoveFileW(source.as_ptr(), target.as_ptr()) } == 0 {
            return Err(err(std::io::Error::last_os_error()));
        }
        Ok(())
    }
    #[cfg(not(windows))] {
        let _ = (source, target);
        Err("重命名目前仅支持 Windows".into())
    }
}
#[tauri::command]
pub fn create_entry(app: tauri::AppHandle, parent: String, name: String, directory: bool) -> Result<String, String> {
    let parent = fs::canonicalize(parent).map_err(err)?;
    if !allowed(&app, &parent) || !valid_name(&name) { return Err("目录或名称无效".into()); }
    let target = parent.join(name);
    if directory { fs::create_dir(&target).map_err(err)?; }
    else {
        if !markdown(&target) { return Err("请使用 Markdown 扩展名".into()); }
        fs::OpenOptions::new().write(true).create_new(true).open(&target).map_err(err)?.sync_all().map_err(err)?;
    }
    Ok(display(&target))
}
#[tauri::command]
pub fn rename_document(app: tauri::AppHandle, path: String, name: String, expected: String) -> Result<String, String> {
    let path = fs::canonicalize(path).map_err(err)?;
    if !allowed(&app, &path) || !valid_name(&name) || !markdown(&path) { return Err("文件或名称无效".into()); }
    let target = path.with_file_name(name);
    if !markdown(&target) { return Err("请使用 Markdown 扩展名".into()); }
    if target == path { return Ok(display(&path)); }
    if target.exists() { return Err("目标名称已存在".into()); }
    if crate::read(&path)?.fingerprint != expected { return Err("文件已被外部修改，请重新加载后重试".into()); }
    rename_no_replace(&path, &target)?;
    app.state::<Access>().documents.lock().map_err(err)?.insert(target.clone());
    Ok(display(&target))
}
#[tauri::command]
pub fn reveal_document(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = fs::canonicalize(path).map_err(err)?;
    if !allowed(&app, &p) { return Err("请先打开文件或工作区".into()); }
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("explorer.exe").arg(format!("/select,{}", display(&p))).creation_flags(0x08000000).spawn().map_err(err)?;
    }
    Ok(())
}
#[tauri::command]
pub fn write_attachment(app: tauri::AppHandle, document: String, name: String, bytes: Vec<u8>) -> Result<String, String> {
    use std::io::Write;
    let doc = fs::canonicalize(document).map_err(err)?;
    if !allowed(&app, &doc) || bytes.len() > 16 * 1024 * 1024 || bytes.is_empty() { return Err("图片无效或超过 16 MB".into()); }
    let ext = Path::new(&name).extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
    if !matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" | "ico") { return Err("不支持的图片格式".into()); }
    let parent = doc.parent().ok_or("无效文档路径")?;
    let assets = parent.join("assets"); fs::create_dir_all(&assets).map_err(err)?;
    let assets = fs::canonicalize(assets).map_err(err)?;
    if !assets.starts_with(parent) { return Err("附件目录不能位于文档目录之外".into()); }
    let mut temp = tempfile::NamedTempFile::new_in(&assets).map_err(err)?;
    temp.write_all(&bytes).map_err(err)?; temp.as_file().sync_all().map_err(err)?;
    let token = temp.path().file_name().unwrap().to_string_lossy().replace('.', "");
    let filename = format!("image-{token}.{ext}");
    temp.persist_noclobber(assets.join(&filename)).map_err(err)?;
    Ok(format!("assets/{filename}"))
}
#[tauri::command]
pub fn import_attachment(app: tauri::AppHandle, document: String, source: String) -> Result<String, String> {
    let p = PathBuf::from(source);
    if fs::metadata(&p).map_err(err)?.len() > 16 * 1024 * 1024 { return Err("图片超过 16 MB".into()); }
    write_attachment(app, document, p.file_name().ok_or("无效图片路径")?.to_string_lossy().into(), fs::read(p).map_err(err)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    #[test] fn rename_never_replaces_destination() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.md"); let target = root.path().join("target.md");
        fs::write(&source, "source").unwrap(); fs::write(&target, "target").unwrap();
        assert!(rename_no_replace(&source, &target).is_err());
        assert_eq!(fs::read_to_string(&source).unwrap(), "source");
        assert_eq!(fs::read_to_string(&target).unwrap(), "target");
        let other = root.path().join("other.md");
        rename_no_replace(&source, &other).unwrap();
        assert!(!source.exists()); assert_eq!(fs::read_to_string(&other).unwrap(), "source");
    }
    #[test] fn search_cancellation_and_cap() {
        let expression = regex::Regex::new("target").unwrap();
        let mut hits = vec![];
        assert!(find_matches("a.md", "target\n".repeat(600).as_str(), &expression, "target", true, "v1", &mut hits, || true));
        assert!(hits.is_empty());
        assert!(!find_matches("a.md", "target\n".repeat(600).as_str(), &expression, "target", true, "v1", &mut hits, || false));
        assert_eq!(hits.len(),501); assert_eq!(hits[0].source_version,"v1");
        assert_eq!(hits[500].from,3500);
    }
    #[test] fn search_chunks_preserve_cross_boundary_matches_and_can_cancel_long_lines() {
        let source = "中".repeat(21845) + "targettarget";
        let mut hits = vec![];
        let expression = regex::Regex::new("target").unwrap();
        assert!(!find_matches("a.md", &source, &expression, "target", true, "v1", &mut hits, ||false));
        assert_eq!(hits.iter().map(|h| h.from).collect::<Vec<_>>(), vec![21845,21851]);
        let checks = std::cell::Cell::new(0);
        assert!(find_matches("a.md", &"a".repeat(300000), &expression, "target", true, "v1", &mut vec![], || { checks.set(checks.get()+1); checks.get()>2 }));
        assert_eq!(checks.get(),3);
        let mut adjacent = vec![];
        find_matches("a.md", &("b".repeat(65535)+"aaaaaa"), &regex::Regex::new("aa").unwrap(), "aa", true, "v1", &mut adjacent, ||false);
        assert_eq!(adjacent.iter().map(|h| h.from).collect::<Vec<_>>(), vec![65535,65537,65539]);
    }
    #[test] fn unicode_search_offsets() {
        let mut hits = vec![]; matches("a.md", "😀中文 AB\n中文", "中文", false, &mut hits);
        assert_eq!((hits[0].from, hits[0].to), (2, 4)); assert_eq!(hits[1].line, 2);
    }
    #[test] fn invalid_names_and_exclusions() {
        for s in ["../a", "a/b", "a:", "a.", ""] { assert!(!valid_name(s)); }
        assert!(valid_name("中文.md")); assert!(excluded(Path::new("root"), Path::new("root/node_modules/x.md")));
    }
}
