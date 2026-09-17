use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::Write, path::{Path, PathBuf}, sync::Mutex};
use tauri::{Emitter, Manager, State};

#[derive(Default)]
struct Access { documents: Mutex<HashSet<PathBuf>>, roots: Mutex<HashSet<PathBuf>>, pending: Mutex<Vec<String>> }
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Document { path: String, content: String, fingerprint: String, bom: bool, newline: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry { name: String, path: String, directory: bool }
fn err(e: impl std::fmt::Display) -> String { e.to_string() }
fn fingerprint(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn markdown(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str()).map(|s| matches!(s.to_ascii_lowercase().as_str(), "md" | "markdown" | "mdown")).unwrap_or(false)
}
fn canonical(path: &str) -> Result<PathBuf, String> { fs::canonicalize(path).map_err(err) }
fn display(path: &Path) -> String {
    let path = path.to_string_lossy();
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") { format!(r"\\{}", rest) }
    else { path.trim_start_matches(r"\\?\").to_owned() }
}
fn decode(path: &Path, bytes: Vec<u8>) -> Result<Document, String> {
    let bom = bytes.starts_with(&[239, 187, 191]);
    let text = std::str::from_utf8(if bom { &bytes[3..] } else { &bytes }).map_err(|_| "此文件不是有效 UTF-8。请先转换编码，原文件未被修改。".to_string())?;
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count();
    Ok(Document { path: display(path), content: text.replace("\r\n", "\n"), fingerprint: fingerprint(&bytes), bom, newline: if crlf > 0 && crlf * 2 >= lf { "CRLF" } else { "LF" }.into() })
}
fn read(path: &Path) -> Result<Document, String> {
    if !markdown(path) { return Err("仅支持 .md、.markdown 和 .mdown 文件".into()); }
    if fs::metadata(path).map_err(err)?.len() > 32 * 1024 * 1024 { return Err("文件超过 32 MB，请拆分后打开。".into()); }
    decode(path, fs::read(path).map_err(err)?)
}
#[tauri::command]
fn read_document(path: String, access: State<Access>) -> Result<Document, String> {
    let path = canonical(&path)?;
    let doc = read(&path)?;
    access.documents.lock().map_err(err)?.insert(path);
    Ok(doc)
}
#[tauri::command]
fn open_workspace(path: String, access: State<Access>) -> Result<String, String> {
    let path = canonical(&path)?;
    if !path.is_dir() { return Err("请选择文件夹".into()); }
    access.roots.lock().map_err(err)?.insert(path.clone());
    Ok(display(&path))
}
#[tauri::command]
fn list_directory(path: String, access: State<Access>) -> Result<Vec<Entry>, String> {
    let path = canonical(&path)?;
    if !access.roots.lock().map_err(err)?.iter().any(|root| path.starts_with(root)) { return Err("请先打开此工作区".into()); }
    let mut entries = Vec::new();
    for item in fs::read_dir(path).map_err(err)? {
        let item = item.map_err(err)?;
        let kind = item.file_type().map_err(err)?;
        let name = item.file_name().to_string_lossy().into_owned();
        // Do not follow directory junctions/symlinks or enumerate generated trees.
        if name.starts_with('.') || matches!(name.as_str(), "node_modules" | "target" | "dist") || kind.is_symlink() { continue; }
        if kind.is_dir() || markdown(&item.path()) { entries.push(Entry { name, path: display(&item.path()), directory: kind.is_dir() }); }
    }
    entries.sort_by(|a,b| b.directory.cmp(&a.directory).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(entries)
}
fn save_bytes(path: &Path, content: &str, expected: Option<&str>, bom: bool, newline: &str) -> Result<Document, String> {
    if !markdown(path) { return Err("请使用 .md、.markdown 或 .mdown 扩展名".into()); }
    match fs::read(path) {
        Ok(bytes) => {
            if expected != Some(fingerprint(&bytes).as_str()) { return Err("CONFLICT".into()); }
            if fs::metadata(path).map_err(err)?.permissions().readonly() { return Err("文件为只读，无法保存。请另存为。".into()); }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => { if expected.is_some() { return Err("CONFLICT".into()); } },
        Err(e) => return Err(err(e)),
    }
    let normalized = content.replace("\r\n", "\n");
    let text = if newline == "CRLF" { normalized.replace('\n', "\r\n") } else { normalized };
    let mut bytes = Vec::with_capacity(text.len() + 3);
    if bom { bytes.extend_from_slice(&[239,187,191]); }
    bytes.extend_from_slice(text.as_bytes());
    let mut tmp = tempfile::NamedTempFile::new_in(path.parent().ok_or("无效保存路径")?).map_err(err)?;
    tmp.write_all(&bytes).map_err(err)?;
    tmp.as_file().sync_all().map_err(err)?;
    // Recheck after writing the temporary file, before atomic replacement.
    let current = match fs::read(path) { Ok(v) => Some(fingerprint(&v)), Err(e) if e.kind() == std::io::ErrorKind::NotFound => None, Err(e) => return Err(err(e)) };
    if current.as_deref() != expected { return Err("CONFLICT".into()); }
    tmp.persist(path).map_err(err)?;
    decode(path, bytes)
}
#[tauri::command]
fn save_document(path: String, content: String, expected: Option<String>, bom: bool, newline: String, access: State<Access>) -> Result<Document, String> {
    let raw = PathBuf::from(&path);
    let path = if raw.exists() { canonical(&path)? } else { fs::canonicalize(raw.parent().ok_or("无效路径")?).map_err(err)?.join(raw.file_name().ok_or("无效文件名")?) };
    let doc = save_bytes(&path, &content, expected.as_deref(), bom, &newline)?;
    access.documents.lock().map_err(err)?.insert(path);
    Ok(doc)
}
#[tauri::command]
fn document_fingerprint(path: String) -> Result<Option<String>, String> {
    let path = PathBuf::from(path);
    if !markdown(&path) { return Err("不支持此文件类型".into()); }
    match fs::read(path) { Ok(v) => Ok(Some(fingerprint(&v))), Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None), Err(e) => Err(err(e)) }
}
fn image_path(document: &Path, reference: &str, roots: &HashSet<PathBuf>) -> Result<PathBuf, String> {
    if reference.contains(':') || reference.starts_with('/') || reference.starts_with('\\') { return Err("仅支持相对路径图片".into()); }
    let parent = document.parent().ok_or("无效文档路径")?;
    let target = fs::canonicalize(parent.join(reference)).map_err(err)?;
    let allowed = target.starts_with(parent) || roots.iter().any(|root| document.starts_with(root) && target.starts_with(root));
    if !allowed { return Err("图片超出文档目录或已打开的工作区".into()); }
    Ok(target)
}
#[tauri::command]
fn read_image(document: String, reference: String, access: State<Access>) -> Result<String, String> {
    let document = canonical(&document)?;
    if !access.documents.lock().map_err(err)?.contains(&document) { return Err("请先打开图片所在文档".into()); }
    let roots = access.roots.lock().map_err(err)?;
    let target = image_path(&document, &reference, &roots)?;
    let ext = target.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let mime = match ext.as_str() { "png" => "image/png", "jpg" | "jpeg" => "image/jpeg", "gif" => "image/gif", "webp" => "image/webp", "bmp" => "image/bmp", "svg" => "image/svg+xml", "ico" => "image/x-icon", _ => return Err("不支持的图片格式".into()) };
    if fs::metadata(&target).map_err(err)?.len() > 16 * 1024 * 1024 { return Err("图片超过 16 MB".into()); }
    Ok(format!("data:{};base64,{}", mime, STANDARD.encode(fs::read(target).map_err(err)?)))
}
#[tauri::command]
fn take_open_paths(access: State<Access>) -> Result<Vec<String>, String> { Ok(std::mem::take(&mut *access.pending.lock().map_err(err)?)) }

pub fn run() {
    tauri::Builder::default()
        .manage(Access::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let paths: Vec<String> = args.into_iter().skip(1).map(|p| PathBuf::from(&cwd).join(p)).filter(|p| p.is_file() && markdown(p)).map(|p| display(&p)).collect();
            if let Ok(mut pending) = app.state::<Access>().pending.lock() { pending.extend(paths); }
            let _ = app.emit("open-paths", ());
            if let Some(window) = app.get_webview_window("main") { let _ = window.unminimize(); let _ = window.set_focus(); }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let paths = std::env::args().skip(1).map(PathBuf::from).filter(|p| p.is_file() && markdown(p)).map(|p| display(&p)).collect();
            *app.state::<Access>().pending.lock().unwrap() = paths;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![read_document, open_workspace, list_directory, save_document, document_fingerprint, read_image, take_open_paths])
        .run(tauri::generate_context!()).expect("无法启动墨页");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn utf8_bom_and_crlf_roundtrip() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("中文 空格.md");
        fs::write(&path, b"\xef\xbb\xbf# hello\r\nworld\r\n").unwrap();
        let doc = read(&path).unwrap(); assert!(doc.bom); assert_eq!(doc.newline,"CRLF");
        save_bytes(&path, &(doc.content + "ok\n"), Some(&doc.fingerprint), doc.bom, &doc.newline).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"\xef\xbb\xbf# hello\r\nworld\r\nok\r\n");
    }
    #[test] fn conflict_does_not_overwrite() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("a.md"); fs::write(&path,"old").unwrap();
        let doc = read(&path).unwrap(); fs::write(&path,"external").unwrap();
        assert_eq!(save_bytes(&path,"mine",Some(&doc.fingerprint),false,"LF").unwrap_err(),"CONFLICT");
        assert_eq!(fs::read_to_string(path).unwrap(),"external");
    }
    #[test] fn invalid_utf8_and_deleted_conflict() {
        let dir = tempfile::tempdir().unwrap(); let path = dir.path().join("a.md"); fs::write(&path,[255,254]).unwrap(); assert!(read(&path).is_err());
        fs::remove_file(&path).unwrap(); assert_eq!(save_bytes(&path,"mine",Some("stale"),false,"LF").unwrap_err(),"CONFLICT");
        assert!(save_bytes(&path,"new",None,false,"LF").is_ok());
    }
    #[test] fn image_scope_blocks_escape() {
        let dir = tempfile::tempdir().unwrap(); let sub = dir.path().join("docs"); fs::create_dir(&sub).unwrap();
        let doc = sub.join("a.md"); fs::write(&doc,"").unwrap(); fs::write(dir.path().join("secret.png"),"x").unwrap();
        let doc = fs::canonicalize(doc).unwrap(); assert!(image_path(&doc,"../secret.png",&HashSet::new()).is_err());
        let roots = HashSet::from([fs::canonicalize(dir.path()).unwrap()]); assert!(image_path(&doc,"../secret.png",&roots).is_ok());
        assert!(image_path(&doc,"https://evil/image.png",&roots).is_err());
    }
}
