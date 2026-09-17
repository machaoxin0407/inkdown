async function showRelease() {
  const status = document.querySelector('#release-status');
  try {
    const response = await fetch('./release.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error('Release unavailable');
    const release = await response.json();
    if (!/^v\d+\.\d+\.\d+$/.test(release.version)) throw new Error('Invalid version');
    for (const name of ['installer', 'portable', 'checksums']) {
      const asset = release.assets[name];
      if (!/^[A-Za-z0-9_.-]+$/.test(asset.name)) throw new Error('Invalid asset');
      document.querySelector(`#${name}`).href = `./downloads/${release.version}/${asset.name}`;
      document.querySelector(`#${name}`).setAttribute('download', asset.name);
      const size = document.querySelector(`#${name}-size`);
      if (size) size.textContent = `${(asset.size / 1e6).toFixed(2)} MB`;
    }
    document.querySelector('#version').textContent = release.version;
    for (const id of ['release-link', 'backup'])
      document.querySelector(`#${id}`).href =
        `https://github.com/machaoxin0407/inkdown/releases/tag/${release.version}`;
    status.textContent = `${release.version} · ${release.date} 发布`;
  } catch {
    status.textContent = '暂时无法读取版本信息，请使用 GitHub 备用下载。';
  }
}
showRelease();
