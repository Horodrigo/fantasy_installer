const { app, BrowserWindow, shell } = require('electron')
const { createServer } = require('node:http')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const { startSignalingServer } = require('./signaling.cjs')

const WEB_PORT = Number(process.env.MAPSTUDIO_WEB_PORT || 4173)
const SIGNALING_PORT = Number(process.env.SIGNALING_PORT || 8787)
const runtimeRoot = path.join(process.resourcesPath, 'runtime', 'app', 'dist')

let webServer = null
let signalingServer = null
let activeWebPort = WEB_PORT
let activeSignalingPort = SIGNALING_PORT

function resolvePath(urlPath) {
  const sanitized = urlPath.split('?')[0]
  const route = sanitized === '/' ? '/index.html' : sanitized
  return path.join(runtimeRoot, route.startsWith('/') ? route.slice(1) : route)
}

function getAvailablePort(preferredPort) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', (error) => {
      if (error && error.code === 'EADDRINUSE') {
        const fallbackProbe = net.createServer()
        fallbackProbe.once('error', reject)
        fallbackProbe.listen(0, '127.0.0.1', () => {
          const { port } = fallbackProbe.address()
          fallbackProbe.close(() => resolve(port))
        })
        return
      }
      reject(error)
    })
    probe.listen(preferredPort, '127.0.0.1', () => {
      probe.close(() => resolve(preferredPort))
    })
  })
}

function startWebServer(port) {
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

  return new Promise((resolve, reject) => {
    webServer.once('error', reject)
    webServer.listen(port, '127.0.0.1', () => resolve())
  })
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

  const appUrl = `http://localhost:${activeWebPort}/?signaling=ws://localhost:${activeSignalingPort}`
  const statusHtml = `
    <html>
      <body style="font-family:Segoe UI, sans-serif; background:#10141d; color:#e8dcc0; padding:24px">
        <h2 style="margin:0 0 12px">Neverending Map Studio Host</h2>
        <p>Servidor local ativo.</p>
        <ul>
          <li>App: <a style="color:#e8a94a" href="${appUrl}">${appUrl}</a></li>
          <li>Sinalização: ws://localhost:${activeSignalingPort}</li>
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

app.whenReady().then(async () => {
  try {
    activeSignalingPort = await getAvailablePort(SIGNALING_PORT)
    activeWebPort = await getAvailablePort(WEB_PORT)
    signalingServer = await startSignalingServer(activeSignalingPort)
    await startWebServer(activeWebPort)
    createWindow()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Falha ao iniciar host local: ${message}`)
    app.quit()
  }
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
