# 网站、发行与回滚

仓库：https://github.com/machaoxin0407/inkdown

网站：http://150.158.39.166/inkdown/ （HTTP；GitHub Releases 为 HTTPS 备用下载）

## 网站发布

修改 `website/`，提交并推送到 `main`；GitHub Actions 的 **Deploy download website** 自动执行。也可在 Actions 页面点击 Run workflow。修改部署脚本同样触发部署；普通桌面源码提交不触发网站发布。

工作流从最新正式 GitHub Release 取得文件，验证所有必需资产及 SHA-256 后生成 `release.json`，将静态网站上传至服务器并原子切换。构建步骤只用 Node.js 内置模块，不需要 npm install。网页运行时只读取本站的 release.json，不调用 GitHub API。

GitHub `production` 环境需要：Secrets `DEPLOY_KEY`、`DEPLOY_KNOWN_HOSTS`；Variables `DEPLOY_HOST`、`DEPLOY_USER`。部署账号没有 sudo；密钥不存入仓库。known_hosts 必须来自经验证的服务器主机密钥，不在每次部署时盲目接受扫描结果。

服务器复用 Caddy；`/inkdown/*` 映射至 `/srv/inkdown/current`，去掉 URL 前缀。`/inkdown` 跳转到末尾带斜线的路径，其他 IP 请求保留原有跳转。配置变更先 `caddy validate` 再 reload。

## 软件新版发布

1. 更新 package.json、package-lock.json、Cargo.toml、Cargo.lock、tauri.conf.json 的一致版本和发行说明。
2. Windows 上执行 `npm ci`、`npm test`、`npm run package`，运行桌面回归。依赖变化时更新第三方许可，再打包。
3. 执行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/collect-release.ps1`。发布资产必须包含 `Inkdown_VERSION_x64-setup.exe`、`Inkdown_VERSION_x64-standalone.zip`、`Inkdown.exe`、`LICENSE`、`THIRD_PARTY_NOTICES.txt` 和 `SHA256SUMS.txt`。校验文件需覆盖前五个文件；仅上传当前版本资产。
4. 提交源码并推送，创建匹配的 `vVERSION` 标签，使用 GitHub Releases 创建草稿，上传六个资产并写明发行说明，然后发布为正式版。不要在已发布的版本上替换文件，修正应发布新版本。
5. `release.published` 触发网站同步。若使用 Actions 的默认 GITHUB_TOKEN 创建 Release，GitHub 不会为此再触发普通工作流，需显式调用网站 workflow_dispatch；人工发布或通过 gh 发布可触发。

首次 v0.1.1 使用现有已验证二进制；免安装包增加开源许可和更新后的文档。后续桌面安装器仍需按此流程在 Windows 构建；不包含自动打包流水线或客户端自动更新。

## 本地检查网站

```powershell
gh release view --repo machaoxin0407/inkdown --json tagName,publishedAt,isDraft,isPrerelease > artifacts/release.json
gh release download v0.1.1 --repo machaoxin0407/inkdown --dir artifacts/release-assets
node scripts/build-website.mjs artifacts/release-assets artifacts/release.json artifacts/site-preview
node scripts/check-website.mjs artifacts/site-preview
```

生成目录必须不存在；重复测试时使用新的输出目录。`check-website.mjs` 使用本机 Chrome，启动临时 HTTP 服务并检查页面，不需要改变服务器。

部署脚本的原子链接切换测试在 Linux 上运行：`python3 -m unittest discover -s tests -p test_website_deploy.py`。普通 Windows 账号可能没有创建符号链接的权限，不能直接完成这项服务器专用测试。

## 日志、失败与回滚

- Actions：https://github.com/machaoxin0407/inkdown/actions/workflows/deploy-website.yml 。日志记录具体失败步骤，不打印私钥。站点部署失败时，已有 current 不变。
- 服务器：`/srv/inkdown/releases/` 保存最近三个成功部署，`current` 指向在线版本。incoming 是传输暂存区；失败上传可由部署账号清理。Caddy 服务日志用 `sudo journalctl -u caddy` 查看。
- 回滚：SSH 登录部署账号，先执行 `readlink -f /srv/inkdown/current` 与 `ls -lt /srv/inkdown/releases`，选择已验证的旧目录。执行 `ln -s /srv/inkdown/releases/所选目录 /srv/inkdown/rollback-link`，再执行 `mv -Tf /srv/inkdown/rollback-link /srv/inkdown/current`。目录名必须从列表中选择；切换后检查网页和下载。无需重启 Caddy。下一次自动部署会再次切到新版本。
- 完整性校验测试覆盖篡改文件、路径穿越和保留版本数；上线时额外对真实服务器执行一次失败包测试，确认 current 不变。
