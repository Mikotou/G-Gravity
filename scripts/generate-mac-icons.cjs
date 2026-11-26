// Run with node scripts/generate-mac-icons.cjs. Use the project's Electron rasterizer on every platform.
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

if (!process.versions.electron) {
  const profile = mkdtempSync(join(tmpdir(), 'gravity-icon-render-'));
  try {
    execFileSync(require('electron'), ['--user-data-dir=' + profile, __filename], {
      shell: false, windowsHide: true, stdio: 'inherit',
    });
  } finally {
    rmSync(profile, { recursive: true, force: true, maxRetries: 4 });
  }
} else {
  const { app, BrowserWindow } = require('electron');
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
    });
    await win.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27none%27; img-src data:">');
    const icons = join(__dirname, '..', 'assets', 'icons');
    for (const name of readdirSync(icons).filter(name => /^gravity-.*\.svg$/.test(name)).sort()) {
      // The C4 source draws its squircle from 22 through 490 in a 512-unit viewBox.
      const svg = readFileSync(join(icons, name), 'utf8').replace('viewBox="0 0 512 512" width="512" height="512"',
        'viewBox="22 22 468 468" width="824" height="824"');
      if (!svg.includes('viewBox="22 22 468 468"')) throw new Error('Unrecognized C4 viewBox in ' + name);
      const url = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
      const render = async source => {
        const image = new Image();
        image.src = source;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1024;
        canvas.getContext('2d').drawImage(image, 100, 100, 824, 824);
        return canvas.toDataURL('image/png').split(',')[1];
      };
      const png = await win.webContents.executeJavaScript('(' + render.toString() + ')(' + JSON.stringify(url) + ')');
      const target = name.replace(/\.svg$/, '-mac.png');
      writeFileSync(join(icons, target), Buffer.from(png, 'base64'));
      console.log(target);
    }
    win.destroy();
    app.quit();
  }).catch(error => { console.error(error); app.exit(1); });
}
