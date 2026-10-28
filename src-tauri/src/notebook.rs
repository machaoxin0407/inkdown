//! Portable notebook libraries. All structure changes are journaled before touching files.
use crate::{canonical, display, err, fingerprint, read, save_bytes, Access, Document};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};

#[derive(Default)]
pub struct NotebookState(pub Mutex<()>);
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub kind: String,
    pub parent: String,
    pub name: String,
    pub path: String,
    pub order: i64,
    pub color: String,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Trash {
    pub id: String,
    pub original_path: String,
    pub stored_path: String,
    pub deleted_at: u64,
    pub items: Vec<Item>,
}
#[derive(Clone, Serialize, Deserialize, Default, Debug)]
pub struct Manifest {
    pub version: u32,
    pub items: Vec<Item>,
    pub trash: Vec<Trash>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    root: String,
    revision: String,
    items: Vec<Item>,
    trash: Vec<Trash>,
    summaries: HashMap<String, Summary>,
    pending: Vec<String>,
    warnings: Vec<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    excerpt: String,
    updated_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub path: String,
    pub expected: String,
    pub content: String,
    pub bom: bool,
    pub newline: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Move {
    pub old_path: String,
    pub new_path: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub revision: String,
    pub moves: Vec<Move>,
    pub mappings: Vec<Move>,
    pub next: Manifest,
    pub action: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Journal {
    plan: Plan,
    edits: Vec<Edit>,
    before: Vec<Edit>,
    moved: bool,
}
#[derive(Serialize)]
pub struct Outcome {
    pub mappings: Vec<Move>,
    pub documents: Vec<Document>,
    pub complete: bool,
    pub errors: Vec<String>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    format!("{:x}-{:x}", now(), N.fetch_add(1, Ordering::Relaxed))
}
fn meta(root: &Path) -> PathBuf {
    root.join(".inkdown/library.json")
}
fn atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let mut f = tempfile::NamedTempFile::new_in(path.parent().ok_or("无效目录")?).map_err(err)?;
    f.write_all(&serde_json::to_vec_pretty(value).map_err(err)?)
        .map_err(err)?;
    f.as_file().sync_all().map_err(err)?;
    f.persist(path).map_err(err)?;
    Ok(())
}
fn load(root: &Path) -> Result<(Manifest, String), String> {
    let b = fs::read(meta(root)).map_err(err)?;
    let m: Manifest = serde_json::from_slice(&b)
        .map_err(|_| "笔记库元数据损坏，请从目录重建；原文件会保留".to_string())?;
    if m.version != 1 {
        return Err("不支持此笔记库版本".into());
    }
    Ok((m, fingerprint(&b)))
}
fn checked(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if relative.is_empty() || rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("无效库内路径".into());
    }
    let mut p = root.to_path_buf();
    for c in rel.components() {
        p.push(c);
        if p.exists() {
            let md = fs::symlink_metadata(&p).map_err(err)?;
            if md.file_type().is_symlink()
                || !fs::canonicalize(&p)
                    .map_err(err)?
                    .starts_with(fs::canonicalize(root).map_err(err)?)
            {
                return Err("不允许符号链接或库外路径".into());
            }
        }
    }
    Ok(p)
}
fn valid_name(s: &str) -> bool {
    let stem = s.split('.').next().unwrap_or("").to_uppercase();
    !s.is_empty()
        && s.len() < 200
        && !s.starts_with('.')
        && !s.ends_with(['.', ' '])
        && !s.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        && !s.chars().any(|c| c.is_control())
        && !matches!(
            stem.as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        )
        && !s.eq_ignore_ascii_case("assets")
}
fn authorized(app: &tauri::AppHandle, root: &str) -> Result<PathBuf, String> {
    let p = canonical(root)?;
    if !app
        .state::<Access>()
        .roots
        .lock()
        .map_err(err)?
        .contains(&p)
    {
        return Err("请先打开笔记库".into());
    }
    checked(&p, ".inkdown")?;
    Ok(p)
}
fn revision(root: &Path, expected: &str) -> Result<Manifest, String> {
    let (m, r) = load(root)?;
    if r != expected {
        return Err("笔记库已变化，请刷新后重试".into());
    }
    Ok(m)
}
fn parent_path(m: &Manifest, parent: &str, kind: &str) -> Result<String, String> {
    if kind == "notebook" && parent.is_empty() {
        return Ok(String::new());
    }
    if kind == "notebook" {
        return Err("笔记本只能位于笔记库根目录".into());
    }
    let p = m
        .items
        .iter()
        .find(|i| i.id == parent)
        .ok_or("请选择笔记本或章节")?;
    if (kind == "chapter" && p.kind != "notebook")
        || (kind == "note" && !matches!(p.kind.as_str(), "chapter" | "notebook"))
    {
        return Err("只支持一层章节".into());
    }
    Ok(p.path.clone())
}
fn next_order(m: &Manifest, parent: &str, kind: &str) -> i64 {
    m.items
        .iter()
        .filter(|i| i.parent == parent && i.kind == kind)
        .map(|i| i.order)
        .max()
        .unwrap_or(-1)
        .saturating_add(1)
}
fn join(p: &str, n: &str) -> String {
    if p.is_empty() {
        n.into()
    } else {
        format!("{p}/{n}")
    }
}
fn under(p: &str, base: &str) -> bool {
    p.eq_ignore_ascii_case(base) || p.to_lowercase().starts_with(&(base.to_lowercase() + "/"))
}
fn relocated(p: &str, a: &str, b: &str) -> String {
    if under(p, a) {
        format!("{}{}", b, &p[a.len()..])
    } else {
        p.into()
    }
}
fn unique(root: &Path, parent: &str, name: &str, kind: &str) -> String {
    let mut n = 0;
    loop {
        let suffix = if n == 0 {
            String::new()
        } else {
            format!(" ({n})")
        };
        let file = format!("{name}{suffix}{}", if kind == "note" { ".md" } else { "" });
        let p = join(parent, &file);
        if !root.join(&p).exists() {
            return p;
        }
        n += 1;
    }
}
fn pending(root: &Path) -> Vec<String> {
    fs::read_dir(root.join(".inkdown/operations"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .map(|e| {
            e.file_name()
                .to_string_lossy()
                .trim_end_matches(".json")
                .to_string()
        })
        .collect()
}
fn idle(root: &Path) -> Result<(), String> {
    if !pending(root).is_empty() {
        Err("请先处理未完成的笔记库操作".into())
    } else {
        Ok(())
    }
}
fn scan(root: &Path, m: &mut Manifest) -> Result<(), String> {
    fn walk(
        root: &Path,
        dir: &Path,
        parent: &str,
        depth: usize,
        m: &mut Manifest,
    ) -> Result<(), String> {
        let mut entries = fs::read_dir(dir)
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().to_string();
            let t = e.file_type().map_err(err)?;
            if name.starts_with('.') || name.eq_ignore_ascii_case("assets") || t.is_symlink() {
                continue;
            }
            let kind = if t.is_dir() && depth < 2 {
                if depth == 0 {
                    "notebook"
                } else {
                    "chapter"
                }
            } else if t.is_file() && depth > 0 && crate::markdown(&e.path()) {
                "note"
            } else {
                continue;
            };
            checked(
                root,
                &e.path().strip_prefix(root).map_err(err)?.to_string_lossy(),
            )?;
            let path = e
                .path()
                .strip_prefix(root)
                .map_err(err)?
                .to_string_lossy()
                .replace('\\', "/");
            let ident = if let Some(i) = m.items.iter().find(|i| i.path.eq_ignore_ascii_case(&path))
            {
                i.id.clone()
            } else {
                let ident = id();
                m.items.push(Item {
                    id: ident.clone(),
                    kind: kind.into(),
                    parent: parent.into(),
                    name: if kind == "note" {
                        Path::new(&name)
                            .file_stem()
                            .unwrap()
                            .to_string_lossy()
                            .into()
                    } else {
                        name
                    },
                    path: path.clone(),
                    order: next_order(m, parent, kind),
                    color: "#68866f".into(),
                });
                ident
            };
            if t.is_dir() {
                walk(root, &e.path(), &ident, depth + 1, m)?;
            }
        }
        Ok(())
    }
    m.items.retain(|i| root.join(&i.path).exists());
    walk(root, root, "", 0, m)
}
fn snapshot(root: &Path) -> Result<Library, String> {
    let (mut m, rev) = load(root)?;
    let jobs = pending(root);
    let mut warnings = vec![];
    if jobs.is_empty() {
        let before = serde_json::to_vec(&m).map_err(err)?;
        scan(root, &mut m)?;
        if before != serde_json::to_vec(&m).map_err(err)? {
            revision(root, &rev)?;
            atomic(&meta(root), &m)?;
        }
    }
    let mut summaries = HashMap::new();
    for i in &m.items {
        if i.kind == "note" {
            match read(&checked(root, &i.path)?) {
                Ok(d) => {
                    let excerpt = d
                        .content
                        .lines()
                        .filter(|l| !l.trim().is_empty())
                        .take(4)
                        .collect::<Vec<_>>()
                        .join(" ")
                        .chars()
                        .take(120)
                        .collect();
                    let updated_at = fs::metadata(root.join(&i.path))
                        .and_then(|x| x.modified())
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_millis() as u64)
                        .unwrap_or(0);
                    summaries.insert(
                        i.id.clone(),
                        Summary {
                            excerpt,
                            updated_at,
                        },
                    );
                }
                Err(e) => warnings.push(format!("{}：{e}", i.name)),
            }
        }
    }
    Ok(Library {
        root: display(root),
        revision: load(root)?.1,
        items: m.items,
        trash: m.trash,
        summaries,
        pending: jobs,
        warnings,
    })
}
#[tauri::command]
pub fn notebook_open(
    app: tauri::AppHandle,
    state: State<NotebookState>,
    path: String,
    create: bool,
    rebuild: bool,
) -> Result<Library, String> {
    let _g = state.0.lock().map_err(err)?;
    let root = canonical(&path)?;
    if !root.is_dir() {
        return Err("请选择文件夹".into());
    }
    let internal = checked(&root, ".inkdown")?;
    if create {
        if meta(&root).exists() {
            return Err("此目录已经是笔记库，请打开已有库".into());
        }
        if fs::read_dir(&root).map_err(err)?.next().is_some() {
            return Err("请为新笔记库选择空文件夹；已有资料请使用导入".into());
        }
        fs::create_dir_all(&internal).map_err(err)?;
        atomic(
            &meta(&root),
            &Manifest {
                version: 1,
                ..Default::default()
            },
        )?;
    }
    if rebuild {
        if !meta(&root).exists() {
            return Err("此文件夹不是墨页笔记库".into());
        }
        idle(&root)?;
        fs::copy(
            meta(&root),
            internal.join(format!("library-backup-{}.json", id())),
        )
        .map_err(err)?;
        let mut m = Manifest {
            version: 1,
            ..Default::default()
        };
        scan(&root, &mut m)?;
        atomic(&meta(&root), &m)?;
    }
    load(&root)?;
    for d in [".inkdown/operations", ".inkdown/trash", "assets"] {
        fs::create_dir_all(checked(&root, d)?).map_err(err)?;
    }
    app.state::<Access>()
        .roots
        .lock()
        .map_err(err)?
        .insert(root.clone());
    snapshot(&root)
}
#[tauri::command]
pub fn notebook_refresh(
    app: tauri::AppHandle,
    state: State<NotebookState>,
    root: String,
) -> Result<Library, String> {
    let _g = state.0.lock().map_err(err)?;
    snapshot(&authorized(&app, &root)?)
}
#[tauri::command]
pub fn notebook_create(
    app: tauri::AppHandle,
    state: State<NotebookState>,
    root: String,
    expected: String,
    parent: String,
    kind: String,
    name: String,
    content: String,
) -> Result<Library, String> {
    let _g = state.0.lock().map_err(err)?;
    let root = authorized(&app, &root)?;
    idle(&root)?;
    let mut m = revision(&root, &expected)?;
    if !matches!(kind.as_str(), "note" | "chapter" | "notebook") || !valid_name(&name) {
        return Err("名称无效或为保留名称".into());
    }
    let p = parent_path(&m, &parent, &kind)?;
    let rel = unique(&root, &p, &name, &kind);
    let path = checked(&root, &rel)?;
    if kind == "note" {
        if content.len() > 32 * 1024 * 1024 {
            return Err("文档超过 32 MB".into());
        }
        save_bytes(&path, &content, None, false, "LF")?;
    } else {
        fs::create_dir(&path).map_err(err)?;
    }
    let order = next_order(&m, &parent, &kind);
    m.items.push(Item {
        id: id(),
        kind: kind.clone(),
        parent,
        name: if kind == "note" {
            path.file_stem().unwrap().to_string_lossy().into()
        } else {
            path.file_name().unwrap().to_string_lossy().into()
        },
        path: rel,
        order,
        color: "#68866f".into(),
    });
    atomic(&meta(&root), &m)?;
    snapshot(&root)
}
#[tauri::command]
pub fn notebook_style(
    app: tauri::AppHandle,
    state: State<NotebookState>,
    root: String,
    expected: String,
    ids: Vec<String>,
    color: Option<String>,
) -> Result<Library, String> {
    let _g = state.0.lock().map_err(err)?;
    let root = authorized(&app, &root)?;
    idle(&root)?;
    let mut m = revision(&root, &expected)?;
    if let Some(c) = color {
        if !["#68866f", "#6285a8", "#b17c64", "#9a7eaf", "#b39956"].contains(&c.as_str()) {
            return Err("无效颜色".into());
        }
        for i in &mut m.items {
            if ids.contains(&i.id) {
                i.color = c.clone()
            }
        }
    } else {
        for (n, key) in ids.iter().enumerate() {
            if let Some(i) = m.items.iter_mut().find(|i| &i.id == key) {
                i.order = n as i64
            }
        }
    }
    atomic(&meta(&root), &m)?;
    snapshot(&root)
}
fn prepare(
    root: &Path,
    expected: &str,
    item_id: &str,
    action: &str,
    parent: &str,
    name: &str,
) -> Result<Plan, String> {
    idle(root)?;
    let mut m = revision(root, expected)?;
    let mut moves = vec![];
    let mut mappings = vec![];
    if action == "restore" {
        let t = m
            .trash
            .iter()
            .find(|t| t.id == item_id)
            .cloned()
            .ok_or("回收站记录不存在")?;
        let base = t.items.first().cloned().ok_or("回收记录为空")?;
        let destination = if parent.is_empty() && name.is_empty() {
            t.original_path.clone()
        } else {
            let n = if name.is_empty() { &base.name } else { name };
            if !valid_name(n) {
                return Err("名称无效".into());
            }
            join(
                &parent_path(
                    &m,
                    if parent.is_empty() {
                        &base.parent
                    } else {
                        parent
                    },
                    &base.kind,
                )?,
                &format!("{n}{}", if base.kind == "note" { ".md" } else { "" }),
            )
        };
        let dst = checked(root, &destination)?;
        if dst.exists() {
            return Err("恢复位置已存在，请选择其他名称或位置".into());
        }
        if !dst.parent().is_some_and(|p| p.exists()) {
            return Err("原位置已不存在，请选择恢复位置".into());
        }
        moves.push(Move {
            old_path: t.stored_path.clone(),
            new_path: destination.clone(),
        });
        for mut i in t.items {
            let old = i.path.clone();
            i.path = relocated(&i.path, &t.original_path, &destination);
            if i.id == base.id {
                if !parent.is_empty() {
                    i.parent = parent.into()
                }
                i.name = (if i.kind == "note" {
                    Path::new(&destination).file_stem()
                } else {
                    Path::new(&destination).file_name()
                })
                .unwrap()
                .to_string_lossy()
                .into();
            }
            if i.kind == "note" {
                mappings.push(Move {
                    old_path: old,
                    new_path: i.path.clone(),
                })
            }
            m.items.push(i)
        }
        m.trash.retain(|x| x.id != item_id);
    } else {
        let item = m
            .items
            .iter()
            .find(|i| i.id == item_id)
            .cloned()
            .ok_or("项目不存在")?;
        if action == "trash" {
            let stored = format!(
                ".inkdown/trash/{}/{}",
                id(),
                Path::new(&item.path).file_name().unwrap().to_string_lossy()
            );
            let mut items = vec![item.clone()];
            items.extend(
                m.items
                    .iter()
                    .filter(|i| i.id != item.id && under(&i.path, &item.path))
                    .cloned(),
            );
            m.items.retain(|i| !under(&i.path, &item.path));
            moves.push(Move {
                old_path: item.path.clone(),
                new_path: stored.clone(),
            });
            m.trash.push(Trash {
                id: id(),
                original_path: item.path,
                stored_path: stored,
                deleted_at: now(),
                items,
            });
        } else if action == "move" {
            let n = if name.is_empty() { &item.name } else { name };
            if !valid_name(n) {
                return Err("名称无效".into());
            }
            let p = parent_path(&m, parent, &item.kind)?;
            let dest = join(
                &p,
                &format!("{n}{}", if item.kind == "note" { ".md" } else { "" }),
            );
            if item.path == dest {
                return Err("位置和名称没有变化".into());
            }
            if checked(root, &dest)?.exists() {
                return Err("目标名称已存在，请改名".into());
            }
            moves.push(Move {
                old_path: item.path.clone(),
                new_path: dest.clone(),
            });
            let order = next_order(&m, parent, &item.kind);
            for i in &mut m.items {
                if under(&i.path, &item.path) {
                    let old = i.path.clone();
                    i.path = relocated(&i.path, &item.path, &dest);
                    if i.kind == "note" {
                        mappings.push(Move {
                            old_path: old,
                            new_path: i.path.clone(),
                        })
                    }
                    if i.id == item.id {
                        i.name = n.into();
                        i.parent = parent.into();
                        i.order = order;
                    }
                }
            }
        } else {
            return Err("未知操作".into());
        }
    }
    Ok(Plan {
        id: id(),
        revision: expected.into(),
        moves,
        mappings,
        next: m,
        action: action.into(),
    })
}
#[tauri::command]
pub fn notebook_prepare(
    app: tauri::AppHandle,
    state: State<NotebookState>,
    root: String,
    expected: String,
    item_id: String,
    action: String,
    parent: String,
    name: String,
) -> Result<Plan, String> {
    let _g = state.0.lock().map_err(err)?;
    let root = authorized(&app, &root)?;
    let p = prepare(&root, &expected, &item_id, &action, &parent, &name)?;
    atomic(
        &root
            .join(".inkdown")
            .join(format!("prepared-{}.json", p.id)),
        &p,
    )?;
    Ok(p)
}
fn run_journal(root: &Path, j: &mut Journal) -> Result<Outcome, String> {
    let file = root
        .join(".inkdown/operations")
        .join(format!("{}.json", j.plan.id));
    let mut out = Outcome {
        mappings: vec![],
        documents: vec![],
        complete: false,
        errors: vec![],
    };
    if !j.moved {
        for mv in &j.plan.moves {
            let src = checked(root, &mv.old_path)?;
            let dst = checked(root, &mv.new_path)?;
            if src.exists() {
                if dst.exists() {
                    return Err("目标位置已存在，操作暂停".into());
                }
                fs::create_dir_all(dst.parent().unwrap()).map_err(err)?;
                super::workspace::rename_no_replace(&src, &dst)?;
            } else if !dst.exists() {
                return Err("源和目标均不存在，请检查文件".into());
            }
        }
        j.moved = true;
        atomic(&file, j)?;
    }
    out.mappings = j.plan.mappings.clone();
    for e in &j.edits {
        let path = checked(root, &e.path)?;
        match read(&path) {
            Ok(d) => {
                if d.content == e.content {
                    out.documents.push(d);
                    continue;
                }
                if d.fingerprint != e.expected {
                    out.errors
                        .push(format!("{}：内容已变化，保留当前版本", e.path));
                    continue;
                }
                match save_bytes(&path, &e.content, Some(&e.expected), e.bom, &e.newline) {
                    Ok(d) => out.documents.push(d),
                    Err(error) => out.errors.push(format!("{}：{error}", e.path)),
                }
            }
            Err(error) => out.errors.push(format!("{}：{error}", e.path)),
        }
    }
    if out.errors.is_empty() {
        let (current, rev) = load(root)?;
        if rev != j.plan.revision
            && serde_json::to_vec(&current).map_err(err)?
                != serde_json::to_vec(&j.plan.next).map_err(err)?
        {
            return Err("元数据被外部修改，恢复暂停".into());
        }
        atomic(&meta(root), &j.plan.next)?;
        let archive = root
            .join(".inkdown")
            .join(format!("completed-{}.json", j.plan.id));
        super::workspace::rename_no_replace(&file, &archive)?;
        out.complete = true;
    }
    Ok(out)
}
#[tauri::command]
pub fn notebook_execute(
    app: tauri::AppHandle,
    state: State<NotebookState>,
    root: String,
    plan_id: String,
    edits: Vec<Edit>,
) -> Result<Outcome, String> {
    let _g = state.0.lock().map_err(err)?;
    let root = authorized(&app, &root)?;
    idle(&root)?;
    if !plan_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err("无效操作标识".into());
    }
    let p: Plan = serde_json::from_slice(
        &fs::read(
            root.join(".inkdown")
                .join(format!("prepared-{plan_id}.json")),
        )
        .map_err(err)?,
    )
    .map_err(err)?;
    revision(&root, &p.revision)?;
    let mut before = vec![];
    for e in &edits {
        let mut source = e.path.clone();
        for mv in &p.moves {
            source = relocated(&source, &mv.new_path, &mv.old_path);
        }
        let d = read(&checked(&root, &source)?)?;
        if d.fingerprint != e.expected {
            return Err(format!("{} 已变化，请重新预检", source));
        }
        if e.content.len() > 32 * 1024 * 1024 {
            return Err("文档超过 32 MB".into());
        }
        before.push(Edit {
            path: source,
            expected: d.fingerprint,
            content: d.content,
            bom: d.bom,
            newline: d.newline,
        });
    }
    let mut j = Journal {
        plan: p,
        edits,
        before,
        moved: false,
    };
    atomic(
        &root
            .join(".inkdown/operations")
            .join(format!("{}.json", j.plan.id)),
        &j,
    )?;
    run_journal(&root, &mut j)
}
#[tauri::command]
pub fn notebook_recover(
    app: tauri::AppHandle,
    state: State<NotebookState>,
    root: String,
    operation: String,
    accept_current: bool,
) -> Result<Outcome, String> {
    let _g = state.0.lock().map_err(err)?;
    let root = authorized(&app, &root)?;
    if !operation.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err("无效操作标识".into());
    }
    let file = root
        .join(".inkdown/operations")
        .join(format!("{operation}.json"));
    let mut j: Journal = serde_json::from_slice(&fs::read(&file).map_err(err)?).map_err(err)?;
    if accept_current {
        j.edits.retain(|e| {
            read(&root.join(&e.path))
                .is_ok_and(|d| d.fingerprint == e.expected || d.content == e.content)
        });
        atomic(&file, &j)?;
    }
    run_journal(&root, &mut j)
}

#[tauri::command]
pub fn notebook_attachment(
    app: tauri::AppHandle,
    state: State<NotebookState>,
    root: String,
    note_id: String,
    name: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let _g = state.0.lock().map_err(err)?;
    let root = authorized(&app, &root)?;
    idle(&root)?;
    let (m, _) = load(&root)?;
    let note = m
        .items
        .iter()
        .find(|i| i.id == note_id && i.kind == "note")
        .ok_or("笔记不存在")?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("图片超过 16 MB".into());
    }
    let ext = Path::new(&name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"].contains(&ext.as_str()) {
        return Err("不支持的图片格式".into());
    }
    let rel = format!("assets/{}/{}.{}", note.id, id(), ext);
    let path = checked(&root, &rel)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(err)?;
    let mut f = tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(err)?;
    f.write_all(&bytes).map_err(err)?;
    f.as_file().sync_all().map_err(err)?;
    f.persist_noclobber(path).map_err(err)?;
    Ok(format!(
        "{}{}",
        "../".repeat(Path::new(&note.path).components().count() - 1),
        rel
    ))
}

#[derive(Serialize, Deserialize)]
pub struct ImportFile {
    pub source: String,
    pub destination: String,
    pub id: String,
    pub document: Document,
}
#[derive(Serialize, Deserialize)]
pub struct ImportPlan {
    pub id: String,
    pub revision: String,
    pub parent: String,
    pub files: Vec<ImportFile>,
    pub warnings: Vec<String>,
}
#[tauri::command]
pub fn notebook_import_prepare(
    app: tauri::AppHandle,
    state: State<NotebookState>,
    root: String,
    expected: String,
    parent: String,
    sources: Vec<String>,
) -> Result<ImportPlan, String> {
    let _g = state.0.lock().map_err(err)?;
    let root = authorized(&app, &root)?;
    idle(&root)?;
    let m = revision(&root, &expected)?;
    let p = parent_path(&m, &parent, "note")?;
    let mut plan = ImportPlan {
        id: id(),
        revision: expected,
        parent,
        files: vec![],
        warnings: vec![],
    };
    for source in sources {
        match canonical(&source).and_then(|p| read(&p)) {
            Ok(d) => {
                let name = Path::new(&source)
                    .file_stem()
                    .unwrap()
                    .to_string_lossy()
                    .to_string();
                if !valid_name(&name) {
                    plan.warnings.push(format!("{source}：文件名无效"));
                    continue;
                }
                let mut dest = unique(&root, &p, &name, "note");
                let mut n = 1;
                while plan
                    .files
                    .iter()
                    .any(|f| f.destination.eq_ignore_ascii_case(&dest))
                {
                    dest = unique(&root, &p, &format!("{name} ({n})"), "note");
                    n += 1;
                }
                plan.files.push(ImportFile {
                    source: d.path.clone(),
                    destination: dest,
                    id: id(),
                    document: d,
                });
            }
            Err(e) => plan.warnings.push(format!("{source}：{e}")),
        }
    }
    atomic(
        &root
            .join(".inkdown")
            .join(format!("import-{}.json", plan.id)),
        &plan,
    )?;
    Ok(plan)
}
#[derive(Serialize, Deserialize)]
pub struct ImportImage {
    pub source: String,
    pub name: String,
    pub expected: String,
}
#[derive(Serialize)]
pub struct ImageProbe {
    pub fingerprint: String,
}
#[tauri::command]
pub fn notebook_probe_image(source: String) -> Result<ImageProbe, String> {
    let p = canonical(&source)?;
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico"].contains(&ext.as_str()) {
        return Err("不支持的图片格式".into());
    }
    if fs::metadata(&p).map_err(err)?.len() > 16 * 1024 * 1024 {
        return Err("图片超过 16 MB".into());
    }
    Ok(ImageProbe {
        fingerprint: fingerprint(&fs::read(p).map_err(err)?),
    })
}
#[tauri::command]
pub fn notebook_image_bytes(source: String) -> Result<Vec<u8>, String> {
    notebook_probe_image(source.clone())?;
    fs::read(source).map_err(err)
}
#[tauri::command]
pub fn notebook_import_commit(
    app: tauri::AppHandle,
    state: State<NotebookState>,
    root: String,
    plan_id: String,
    file_id: String,
    content: String,
    images: Vec<ImportImage>,
) -> Result<String, String> {
    let _g = state.0.lock().map_err(err)?;
    let root = authorized(&app, &root)?;
    idle(&root)?;
    if !plan_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err("无效导入标识".into());
    }
    let plan: ImportPlan = serde_json::from_slice(
        &fs::read(root.join(".inkdown").join(format!("import-{plan_id}.json"))).map_err(err)?,
    )
    .map_err(err)?;
    let f = plan
        .files
        .iter()
        .find(|f| f.id == file_id)
        .ok_or("导入文件不存在")?;
    if read(&canonical(&f.source)?)?.fingerprint != f.document.fingerprint {
        return Err("来源文件已变化，请重新预检".into());
    }
    let (mut m, initial_revision) = load(&root)?;
    let parent = parent_path(&m, &plan.parent, "note")?;
    if Path::new(&f.destination).parent() != Some(Path::new(&parent)) {
        return Err("目标章节已移动，请重新导入".into());
    }
    let dst = checked(&root, &f.destination)?;
    if dst.exists() {
        return Err("目标文件已存在".into());
    }
    if content.len() > 32 * 1024 * 1024 {
        return Err("文档超过 32 MB".into());
    }
    let stage = tempfile::tempdir_in(root.join(".inkdown")).map_err(err)?;
    for img in images {
        if !valid_name(&img.name) {
            return Err("图片名称无效".into());
        }
        notebook_probe_image(img.source.clone())?;
        let bytes = fs::read(&img.source).map_err(err)?;
        if fingerprint(&bytes) != img.expected {
            return Err("来源图片已变化，请重新导入".into());
        }
        fs::write(stage.path().join(img.name), bytes).map_err(err)?;
    }
    let assets = checked(&root, &format!("assets/{}", f.id))?;
    if assets.exists() {
        return Err("导入附件已存在，请重新预检".into());
    }
    let staged_note = stage.path().join(".import.md");
    save_bytes(
        &staged_note,
        &content,
        None,
        f.document.bom,
        &f.document.newline,
    )?;
    let note_bytes = fs::read(&staged_note).map_err(err)?;
    fs::remove_file(&staged_note).map_err(err)?;
    super::workspace::rename_no_replace(stage.path(), &assets)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dst.parent().unwrap()).map_err(err)?;
    tmp.write_all(&note_bytes).map_err(err)?;
    tmp.as_file().sync_all().map_err(err)?;
    tmp.persist_noclobber(&dst).map_err(err)?;
    let order = next_order(&m, &plan.parent, "note");
    m.items.push(Item {
        id: f.id.clone(),
        kind: "note".into(),
        parent: plan.parent,
        name: dst.file_stem().unwrap().to_string_lossy().into(),
        path: f.destination.clone(),
        order,
        color: "#68866f".into(),
    });
    if let Err(error) = revision(&root, &initial_revision).and_then(|_| atomic(&meta(&root), &m)) {
        // Remove only our exact newly-created body; never remove a later external edit.
        if fs::read(&dst).is_ok_and(|bytes| bytes == note_bytes) {
            fs::remove_file(&dst).map_err(err)?;
        }
        return Err(error);
    }
    Ok(display(&dst))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn library() -> tempfile::TempDir {
        let t = tempfile::tempdir().unwrap();
        for p in [".inkdown/operations", ".inkdown/trash", "assets"] {
            fs::create_dir_all(t.path().join(p)).unwrap()
        }
        atomic(
            &meta(t.path()),
            &Manifest {
                version: 1,
                ..Default::default()
            },
        )
        .unwrap();
        t
    }
    #[test]
    fn hierarchy_scan_and_metadata_conflict() {
        let t = library();
        fs::create_dir_all(t.path().join("网络/传输层")).unwrap();
        fs::write(t.path().join("网络/传输层/TCP.md"), "# TCP").unwrap();
        let l = snapshot(t.path()).unwrap();
        assert_eq!(l.items.len(), 3);
        let again = snapshot(t.path()).unwrap();
        assert_eq!(l.items[2].id, again.items[2].id);
        assert!(revision(t.path(), "wrong").is_err());
        assert!(checked(t.path(), "../escape").is_err());
        assert!(!valid_name("CON"));
    }
    #[test]
    fn move_journal_preserves_conflicting_edits() {
        let t = library();
        fs::create_dir(t.path().join("网络")).unwrap();
        fs::write(t.path().join("网络/A.md"), "before").unwrap();
        let l = snapshot(t.path()).unwrap();
        let n = l.items.iter().find(|n| n.kind == "note").unwrap();
        let p = prepare(t.path(), &l.revision, &n.id, "move", &n.parent, "B").unwrap();
        let before = read(&t.path().join(&n.path)).unwrap();
        let mut j = Journal {
            plan: p,
            edits: vec![Edit {
                path: "网络/B.md".into(),
                expected: before.fingerprint,
                content: "after".into(),
                bom: false,
                newline: "LF".into(),
            }],
            before: vec![],
            moved: false,
        };
        atomic(
            &t.path()
                .join(format!(".inkdown/operations/{}.json", j.plan.id)),
            &j,
        )
        .unwrap();
        fs::write(t.path().join("网络/A.md"), "external").unwrap();
        let r = run_journal(t.path(), &mut j).unwrap();
        assert!(!r.complete);
        assert_eq!(
            fs::read_to_string(t.path().join("网络/B.md")).unwrap(),
            "external"
        );
        assert_eq!(pending(t.path()).len(), 1);
    }
    #[test]
    fn trash_restore_preserves_identity() {
        let t = library();
        fs::create_dir(t.path().join("数学")).unwrap();
        fs::write(t.path().join("数学/函数.md"), "函数").unwrap();
        let l = snapshot(t.path()).unwrap();
        let n = l.items.iter().find(|n| n.kind == "note").unwrap();
        let mut j = Journal {
            plan: prepare(t.path(), &l.revision, &n.id, "trash", "", "").unwrap(),
            edits: vec![],
            before: vec![],
            moved: false,
        };
        atomic(
            &t.path()
                .join(format!(".inkdown/operations/{}.json", j.plan.id)),
            &j,
        )
        .unwrap();
        assert!(run_journal(t.path(), &mut j).unwrap().complete);
        let l = snapshot(t.path()).unwrap();
        assert_eq!(l.trash.len(), 1);
        let p = prepare(t.path(), &l.revision, &l.trash[0].id, "restore", "", "").unwrap();
        assert!(p.next.items.iter().any(|i| i.id == n.id));
    }
}
