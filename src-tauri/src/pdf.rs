use std::{fs, io::Write, path::PathBuf};

#[tauri::command]
pub async fn export_pdf(window: tauri::WebviewWindow, path: String) -> Result<(), String> {
    if window.label() != "main" { return Err("无权导出".into()); }
    let target = PathBuf::from(path);
    if !target.is_absolute() || !target.extension().is_some_and(|s| s.eq_ignore_ascii_case("pdf")) {
        return Err("请选择 .pdf 保存路径".into());
    }
    let expected = match fs::read(&target) {
        Ok(bytes) => {
            if fs::metadata(&target).map_err(super::err)?.permissions().readonly() { return Err("目标 PDF 为只读，请选择其他位置".into()); }
            Some(super::fingerprint(&bytes))
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(super::err(e)),
    };
    let parent = target.parent().ok_or("无效保存路径")?;
    let temp = tempfile::tempdir_in(parent).map_err(super::err)?;
    let pdf_path = temp.path().join("document.pdf");
    #[cfg(windows)]
    {
        use windows::core::{Interface, HSTRING};
        use webview2_com::{Microsoft::Web::WebView2::Win32::{ICoreWebView2_7, ICoreWebView2Environment6}, PrintToPdfCompletedHandler};
        let (tx, rx) = std::sync::mpsc::channel();
        let output = pdf_path.clone();
        window.with_webview(move |webview| unsafe {
            let done = tx.clone();
            let result = (|| -> windows::core::Result<()> {
                let core: ICoreWebView2_7 = webview.controller().CoreWebView2()?.cast()?;
                let environment: ICoreWebView2Environment6 = webview.environment().cast()?;
                let settings = environment.CreatePrintSettings()?;
                settings.SetPageWidth(8.2677)?;
                settings.SetPageHeight(11.6929)?;
                settings.SetMarginTop(0.59)?;
                settings.SetMarginBottom(0.59)?;
                settings.SetMarginLeft(0.59)?;
                settings.SetMarginRight(0.59)?;
                settings.SetShouldPrintBackgrounds(true)?;
                settings.SetShouldPrintHeaderAndFooter(false)?;
                let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, success| {
                    let outcome = result.map_err(super::err).and_then(|_| if success { Ok(()) } else { Err("PDF 导出失败，请选择可写位置后重试".into()) });
                    let _ = done.send(outcome);
                    Ok(())
                }));
                core.PrintToPdf(&HSTRING::from(output.to_string_lossy().as_ref()), &settings, &handler)
            })();
            if let Err(e) = result { let _ = tx.send(Err(format!("无法导出 PDF，请检查 WebView2 运行时：{e}"))); }
        }).map_err(super::err)?;
        tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(120)))
            .await.map_err(super::err)?.map_err(|_| "PDF 导出超时，请重试".to_string())??;
    }
    #[cfg(not(windows))]
    return Err("PDF 导出目前仅支持 Windows".into());
    let bytes = fs::read(&pdf_path).map_err(super::err)?;
    if !bytes.starts_with(b"%PDF-") { return Err("导出结果不是有效 PDF".into()); }
    let mut saved = tempfile::NamedTempFile::new_in(parent).map_err(super::err)?;
    saved.write_all(&bytes).map_err(super::err)?;
    saved.as_file().sync_all().map_err(super::err)?;
    let current = match fs::read(&target) {
        Ok(v) => Some(super::fingerprint(&v)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(super::err(e)),
    };
    if current != expected { return Err("目标 PDF 在导出期间被修改，请重新导出到其他位置".into()); }
    saved.persist(target).map_err(super::err)?;
    Ok(())
}
