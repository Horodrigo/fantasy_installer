const { app, BrowserWindow, shell } = require('electron')
const { createServer } = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { startSignalingServer } = require('./signaling.cjs')

const WEB_PORT = Number(process.env.MAPSTUDIO_WEB_PORT || 4173)
const SIGNALING_PORT = Number(process.env.SIGNALING_PORT || 8787)
const runtimeRoot = path.join(process.resourcesPath, 'runtime', 'app', 'dist')

let webServer = null
let signalingServer = null

function resolvePath(urlPath) {
  const sanitized = urlPath.split('?')[0]
  const route = sanitized === '/' ? '/index.html' : sanitized
  return path.join(runtimeRoot, route.startsWith('/') ? route.slice(1) : route)
}

function startWebServer() {
  if (!fs.existsSync(runtimeRoot)) {
    throw new Error(`Dist não encontrado em ${runtimeRoot}`)
  }

  webServer = createServer((req, res) => {
    const filePath = resolvePath(req.url || '/')
    const fallbackPath = path.join(runtimeRoot, 'index.html')
    const targetPath = fs.existsSync(filePath) ? filePath : fallbackPath
    fs.readFile(targetPath, (error, content) => {
      if (error) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Erro ao ler arquivos da aplicação.')
        return
      }
      const extension = path.extname(targetPath)
      const contentType =
        extension === '.css'
          ? 'text/css; charset=utf-8'
          : extension === '.js'
            ? 'text/javascript; charset=utf-8'
            : extension === '.json'
              ? 'application/json; charset=utf-8'
              : extension === '.svg'
                ? 'image/svg+xml'
                : 'text/html; charset=utf-8'
      res.writeHead(200, { 'content-type': contentType })
      res.end(content)
    })
  })

  webServer.listen(WEB_PORT)
}

function createWindow() {
  const window = new BrowserWindow({
    width: 560,
    height: 340,
    title: 'Neverending Map Studio Host',
    webPreferences: {
      contextIsolation: true,
    },
  })

  const appUrl = `http://localhost:${WEB_PORT}/`
  const statusHtml = `
    <html>
      <body style="font-family:Segoe UI, sans-serif; background:#10141d; color:#e8dcc0; padding:24px">
        <h2 style="margin:0 0 12px">Neverending Map Studio Host</h2>
        <p>Servidor local ativo.</p>
        <ul>
          <li>App: <a style="color:#e8a94a" href="${appUrl}">${appUrl}</a></li>
          <li>Sinalização: ws://localhost:${SIGNALING_PORT}</li>
        </ul>
        <button id="open">Abrir aplicação no navegador</button>
        <script>
          document.getElementById('open').addEventListener('click', () => {
            window.open('${appUrl}', '_blank');
          });
        </script>
      </body>
    </html>
  `
  window.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(statusHtml)}`)
  void shell.openExternal(appUrl)
}

app.whenReady().then(() => {
  signalingServer = startSignalingServer(SIGNALING_PORT)
  startWebServer()
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  if (webServer) {
    webServer.close()
  }
  if (signalingServer) {
    signalingServer.close()
  }
})
