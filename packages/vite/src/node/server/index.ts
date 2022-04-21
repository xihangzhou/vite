import fs from 'fs'
import path from 'path'
import type * as net from 'net'
import type * as http from 'http'
import connect from 'connect'
import corsMiddleware from 'cors'
import colors from 'picocolors'
import type { AddressInfo } from 'net'
import chokidar from 'chokidar'
import type { CommonServerOptions } from '../http'
import { resolveHttpsConfig, resolveHttpServer, httpServerStart } from '../http'
import type { InlineConfig, ResolvedConfig } from '../config'
import { mergeConfig, resolveConfig } from '../config'
import type { PluginContainer } from './pluginContainer'
import { createPluginContainer } from './pluginContainer'
import type { FSWatcher, WatchOptions } from 'types/chokidar'
import type { WebSocketServer } from './ws'
import { createWebSocketServer } from './ws'
import { baseMiddleware } from './middlewares/base'
import { proxyMiddleware } from './middlewares/proxy'
import { spaFallbackMiddleware } from './middlewares/spaFallback'
import { transformMiddleware } from './middlewares/transform'
import {
  createDevHtmlTransformFn,
  indexHtmlMiddleware
} from './middlewares/indexHtml'
import {
  serveRawFsMiddleware,
  servePublicMiddleware,
  serveStaticMiddleware
} from './middlewares/static'
import { timeMiddleware } from './middlewares/time'
import type { ModuleNode } from './moduleGraph'
import { ModuleGraph } from './moduleGraph'
import type { Connect } from 'types/connect'
import { isParentDirectory, normalizePath } from '../utils'
import { errorMiddleware, prepareError } from './middlewares/error'
import type { HmrOptions } from './hmr'
import { handleHMRUpdate, handleFileAddUnlink } from './hmr'
import { openBrowser } from './openBrowser'
import launchEditorMiddleware from 'launch-editor-middleware'
import type { TransformOptions, TransformResult } from './transformRequest'
import { transformRequest } from './transformRequest'
import type { ESBuildTransformResult } from '../plugins/esbuild'
import { transformWithEsbuild } from '../plugins/esbuild'
import type { TransformOptions as EsbuildTransformOptions } from 'esbuild'
import { ssrLoadModule } from '../ssr/ssrModuleLoader'
import { resolveSSRExternal } from '../ssr/ssrExternal'
import {
  rebindErrorStacktrace,
  ssrRewriteStacktrace
} from '../ssr/ssrStacktrace'
import { ssrTransform } from '../ssr/ssrTransform'
import { createOptimizedDeps } from '../optimizer/registerMissing'
import type { OptimizedDeps } from '../optimizer'
import { resolveHostname } from '../utils'
import { searchForWorkspaceRoot } from './searchRoot'
import { CLIENT_DIR } from '../constants'
import { printCommonServerUrls } from '../logger'
import { performance } from 'perf_hooks'
import { invalidatePackageData } from '../packages'
import type { SourceMap } from 'rollup'

export { searchForWorkspaceRoot } from './searchRoot'

export interface ServerOptions extends CommonServerOptions {
  /**
   * Force dep pre-optimization regardless of whether deps have changed.
   */
  force?: boolean
  /**
   * Configure HMR-specific options (port, host, path & protocol)
   */
  hmr?: HmrOptions | boolean
  /**
   * chokidar watch options
   * https://github.com/paulmillr/chokidar#api
   */
  watch?: WatchOptions
  /**
   * Create Vite dev server to be used as a middleware in an existing server
   */
  middlewareMode?: boolean | 'html' | 'ssr'
  /**
   * Prepend this folder to http requests, for use when proxying vite as a subfolder
   * Should start and end with the `/` character
   */
  base?: string
  /**
   * Options for files served via '/\@fs/'.
   */
  fs?: FileSystemServeOptions
  /**
   * Origin for the generated asset URLs.
   */
  origin?: string
  /**
   * Pre-transform known direct imports
   *
   * @experimental this option is experimental and might be changed in the future
   * @default true
   */
  preTransformRequests?: boolean
}

export interface ResolvedServerOptions extends ServerOptions {
  fs: Required<FileSystemServeOptions>
}

export interface FileSystemServeOptions {
  /**
   * Strictly restrict file accessing outside of allowing paths.
   *
   * Set to `false` to disable the warning
   *
   * @default true
   */
  strict?: boolean

  /**
   * Restrict accessing files outside the allowed directories.
   *
   * Accepts absolute path or a path relative to project root.
   * Will try to search up for workspace root by default.
   */
  allow?: string[]

  /**
   * Restrict accessing files that matches the patterns.
   *
   * This will have higher priority than `allow`.
   * Glob patterns are supported.
   *
   * @default ['.env', '.env.*', '*.crt', '*.pem']
   *
   * @experimental
   */
  deny?: string[]
}

export type ServerHook = (
  server: ViteDevServer
) => (() => void) | void | Promise<(() => void) | void>

export interface ViteDevServer {
  /**
   * The resolved vite config object
   */
  config: ResolvedConfig
  /**
   * A connect app instance.
   * - Can be used to attach custom middlewares to the dev server.
   * - Can also be used as the handler function of a custom http server
   *   or as a middleware in any connect-style Node.js frameworks
   *
   * https://github.com/senchalabs/connect#use-middleware
   */
  middlewares: Connect.Server
  /**
   * @deprecated use `server.middlewares` instead
   */
  app: Connect.Server
  /**
   * native Node http server instance
   * will be null in middleware mode
   */
  httpServer: http.Server | null
  /**
   * chokidar watcher instance
   * https://github.com/paulmillr/chokidar#api
   */
  watcher: FSWatcher
  /**
   * web socket server with `send(payload)` method
   */
  ws: WebSocketServer
  /**
   * Rollup plugin container that can run plugin hooks on a given file
   */
  pluginContainer: PluginContainer
  /**
   * Module graph that tracks the import relationships, url to file mapping
   * and hmr state.
   */
  moduleGraph: ModuleGraph
  /**
   * Programmatically resolve, load and transform a URL and get the result
   * without going through the http request pipeline.
   */
  transformRequest(
    url: string,
    options?: TransformOptions
  ): Promise<TransformResult | null>
  /**
   * Apply vite built-in HTML transforms and any plugin HTML transforms.
   */
  transformIndexHtml(
    url: string,
    html: string,
    originalUrl?: string
  ): Promise<string>
  /**
   * Util for transforming a file with esbuild.
   * Can be useful for certain plugins.
   *
   * @deprecated import `transformWithEsbuild` from `vite` instead
   */
  transformWithEsbuild(
    code: string,
    filename: string,
    options?: EsbuildTransformOptions,
    inMap?: object
  ): Promise<ESBuildTransformResult>
  /**
   * Transform module code into SSR format.
   * @experimental
   */
  ssrTransform(
    code: string,
    inMap: SourceMap | null,
    url: string
  ): Promise<TransformResult | null>
  /**
   * Load a given URL as an instantiated module for SSR.
   */
  ssrLoadModule(
    url: string,
    opts?: { fixStacktrace?: boolean }
  ): Promise<Record<string, any>>
  /**
   * Returns a fixed version of the given stack
   */
  ssrRewriteStacktrace(stack: string): string
  /**
   * Mutates the given SSR error by rewriting the stacktrace
   */
  ssrFixStacktrace(e: Error): void
  /**
   * Start the server.
   */
  listen(port?: number, isRestart?: boolean): Promise<ViteDevServer>
  /**
   * Stop the server.
   */
  close(): Promise<void>
  /**
   * Print server urls
   */
  printUrls(): void
  /**
   * Restart the server.
   *
   * @param forceOptimize - force the optimizer to re-bundle, same as --force cli flag
   */
  restart(forceOptimize?: boolean): Promise<void>
  /**
   * @internal
   */
  _optimizedDeps: OptimizedDeps | null
  /**
   * Deps that are externalized
   * @internal
   */
  _ssrExternals: string[] | null
  /**
   * @internal
   */
  _globImporters: Record<
    string,
    {
      module: ModuleNode
      importGlobs: {
        base: string
        pattern: string
      }[]
    }
  >
  /**
   * @internal
   */
  _restartPromise: Promise<void> | null
  /**
   * @internal
   */
  _forceOptimizeOnRestart: boolean
  /**
   * @internal
   */
  _pendingRequests: Map<
    string,
    {
      request: Promise<TransformResult | null>
      timestamp: number
      abort: () => void
    }
  >
}

export async function createServer(
  inlineConfig: InlineConfig = {}
): Promise<ViteDevServer> {
  // 解析服务的配置返回为配置实例
  const config = await resolveConfig(inlineConfig, 'serve', 'development')
  const root = config.root // 项目运行的根目录
  const serverConfig = config.server // 服务配置
  const httpsOptions = await resolveHttpsConfig(
    // 再解析https的配置
    config.server.https,
    config.cacheDir
  )
  // https://vitejs.dev/config/#server-middlewaremode
  let { middlewareMode } = serverConfig
  if (middlewareMode === true) {
    middlewareMode = 'ssr'
  }

  // 一个服务实例
  const middlewares = connect() as Connect.Server
  // 如果不是ssr模式的话就传入服务配置返回一个httpServer实例
  const httpServer = middlewareMode
    ? null
    : await resolveHttpServer(serverConfig, middlewares, httpsOptions)
  // 生成监听这个httpServer的webSocketServer
  const ws = createWebSocketServer(httpServer, config, httpsOptions)

  const { ignored = [], ...watchOptions } = serverConfig.watch || {}
  // 监听文件的变动
  const watcher = chokidar.watch(path.resolve(root), {
    ignored: [
      '**/node_modules/**',
      '**/.git/**',
      ...(Array.isArray(ignored) ? ignored : [ignored])
    ],
    ignoreInitial: true,
    ignorePermissionErrors: true,
    disableGlobbing: true,
    ...watchOptions
  }) as FSWatcher

  // 存储任何一个文件和模块的映射关系，传入的参数是oluginContainer的resolveId方法的封装
  const moduleGraph: ModuleGraph = new ModuleGraph((url, ssr) =>
    container.resolveId(url, undefined, { ssr })
  )

  // 插件container,可以去执行对应的rollup plugin的hooks
  // 这里就是返回了一个实例，具体的方法执行在后面
  const container = await createPluginContainer(config, moduleGraph, watcher)
  const closeHttpServer = createServerCloseFn(httpServer) // 返回一个关闭服务的函数，关闭服务的同时手动关闭所有连接

  // eslint-disable-next-line prefer-const
  let exitProcess: () => void

  // 这个就是最后需要返回的server实例，具体定义在实例上的方法被调用的时候再回头看看
  const server: ViteDevServer = {
    config,
    middlewares,
    get app() {
      config.logger.warn(
        `ViteDevServer.app is deprecated. Use ViteDevServer.middlewares instead.`
      )
      return middlewares
    },
    httpServer,
    watcher,
    pluginContainer: container,
    ws,
    moduleGraph,
    ssrTransform,
    transformWithEsbuild,
    transformRequest(url, options) {
      return transformRequest(url, server, options)
    },
    transformIndexHtml: null!, // to be immediately set
    async ssrLoadModule(url, opts?: { fixStacktrace?: boolean }) {
      if (!server._ssrExternals) {
        let knownImports: string[] = []
        const optimizedDeps = server._optimizedDeps
        if (optimizedDeps) {
          await optimizedDeps.scanProcessing
          knownImports = [
            ...Object.keys(optimizedDeps.metadata.optimized),
            ...Object.keys(optimizedDeps.metadata.discovered)
          ]
        }
        server._ssrExternals = resolveSSRExternal(config, knownImports)
      }
      return ssrLoadModule(
        url,
        server,
        undefined,
        undefined,
        opts?.fixStacktrace
      )
    },
    ssrFixStacktrace(e) {
      if (e.stack) {
        const stacktrace = ssrRewriteStacktrace(e.stack, moduleGraph)
        rebindErrorStacktrace(e, stacktrace)
      }
    },
    ssrRewriteStacktrace(stack: string) {
      return ssrRewriteStacktrace(stack, moduleGraph)
    },
    listen(port?: number, isRestart?: boolean) {
      return startServer(server, port, isRestart)
    },
    async close() {
      process.off('SIGTERM', exitProcess)

      if (!middlewareMode && process.env.CI !== 'true') {
        process.stdin.off('end', exitProcess)
      }

      await Promise.all([
        watcher.close(),
        ws.close(),
        container.close(),
        closeHttpServer()
      ])
    },
    printUrls() {
      if (httpServer) {
        printCommonServerUrls(httpServer, config.server, config)
      } else {
        throw new Error('cannot print server URLs in middleware mode.')
      }
    },
    async restart(forceOptimize?: boolean) {
      if (!server._restartPromise) {
        server._forceOptimizeOnRestart = !!forceOptimize
        server._restartPromise = restartServer(server).finally(() => {
          server._restartPromise = null
          server._forceOptimizeOnRestart = false
        })
      }
      return server._restartPromise
    },

    _optimizedDeps: null,
    _ssrExternals: null,
    _globImporters: Object.create(null),
    _restartPromise: null,
    _forceOptimizeOnRestart: false,
    _pendingRequests: new Map()
  }

  // 转换index.html文件为真正返回的index.html的函数
  // 注意transformIndexHtml是一个函数
  server.transformIndexHtml = createDevHtmlTransformFn(server)

  exitProcess = async () => {
    try {
      await server.close()
    } finally {
      process.exit(0)
    }
  }

  process.once('SIGTERM', exitProcess)

  if (!middlewareMode && process.env.CI !== 'true') {
    process.stdin.on('end', exitProcess)
  }

  const { packageCache } = config // packageCache是一个Map对象实例，是一个key到packageCaacheData的映射
  // 重写set方法
  const setPackageData = packageCache.set.bind(packageCache)
  packageCache.set = (id, pkg) => {
    // 如果id是json文件监听器就加入对这个文件的监听
    if (id.endsWith('.json')) {
      watcher.add(id)
    }
    return setPackageData(id, pkg)
  }

  // 监听到文件变化过后的回调
  watcher.on('change', async (file) => {
    file = normalizePath(file) // 把一个路径转换为一个绝对路径
    // 如果是一个package.json文件
    if (file.endsWith('/package.json')) {
      return invalidatePackageData(packageCache, file) // 从packageCache缓存中删除这个packge.json文件的配置
    }
    // invalidate module graph cache on file change
    moduleGraph.onFileChange(file)
    if (serverConfig.hmr !== false) {
      try {
        await handleHMRUpdate(file, server)
      } catch (err) {
        ws.send({
          type: 'error',
          err: prepareError(err)
        })
      }
    }
  })

  // 加入文件过后的回调
  watcher.on('add', (file) => {
    handleFileAddUnlink(normalizePath(file), server)
  })

  // unlink后的回调
  watcher.on('unlink', (file) => {
    handleFileAddUnlink(normalizePath(file), server, true)
  })

  if (!middlewareMode && httpServer) {
    httpServer.once('listening', () => {
      // update actual port since this may be different from initial value
      serverConfig.port = (httpServer.address() as AddressInfo).port
    })
  }

  // apply server configuration hooks from plugins
  const postHooks: ((() => void) | void)[] = []
  for (const plugin of config.plugins) {
    // configureServer是用于配置开发服务器的钩子。最常见的用例是在内部 connect 应用程序中添加自定义中间件:
    if (plugin.configureServer) {
      postHooks.push(await plugin.configureServer(server))
    }
  }

  // Internal middlewares ------------------------------------------------------
  // 定义各种中间件

  // request timer
  // 请求时间监控
  if (process.env.DEBUG) {
    middlewares.use(timeMiddleware(root))
  }

  // cors (enabled by default)
  // 跨域cors是否开启
  const { cors } = serverConfig
  if (cors !== false) {
    middlewares.use(corsMiddleware(typeof cors === 'boolean' ? {} : cors))
  }

  // proxy
  // 代理设置
  const { proxy } = serverConfig
  if (proxy) {
    // 使用http-proxy这个库完成代理的实现
    middlewares.use(proxyMiddleware(httpServer, config))
  }

  // base
  // 修改请求路径的base
  if (config.base !== '/') {
    middlewares.use(baseMiddleware(server))
  }

  // open in editor support
  // use方法第一个参数可以为字符串，标记为请求路径，即只有这个路径才走这个中间件
  middlewares.use('/__open-in-editor', launchEditorMiddleware())

  // hmr reconnect ping
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  middlewares.use('/__vite_ping', function viteHMRPingMiddleware(_, res) {
    res.end('pong')
  })

  // serve static files under /public
  // this applies before the transform middleware so that these files are served
  // as-is without transforms.
  // https://cn.vitejs.dev/guide/assets.html#the-public-directory
  // 所有静态资源应该存放的文件夹
  if (config.publicDir) {
    middlewares.use(servePublicMiddleware(config.publicDir))
  }

  // main transform middleware
  // 转换路径的中间件
  middlewares.use(transformMiddleware(server))

  // serve static files
  middlewares.use(serveRawFsMiddleware(server))
  middlewares.use(serveStaticMiddleware(root, server))

  // spa fallback
  if (!middlewareMode || middlewareMode === 'html') {
    middlewares.use(spaFallbackMiddleware(root))
  }

  // run post config hooks
  // This is applied before the html middleware so that user middleware can
  // serve custom content instead of index.html.
  // configureServer周期的postHooks的执行
  postHooks.forEach((fn) => fn && fn())

  //https://cn.vitejs.dev/config/#server-middlewaremode
  // 以中间件模式创建 Vite 服务器。（不含 HTTP 服务器）

  // 'ssr' 将禁用 Vite 自身的 HTML 服务逻辑，因此你应该手动为 index.html 提供服务。
  // 'html' 将启用 Vite 自身的 HTML 服务逻辑。
  if (!middlewareMode || middlewareMode === 'html') {
    // transform index.html
    middlewares.use(indexHtmlMiddleware(server))
    // handle 404s
    // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
    middlewares.use(function vite404Middleware(_, res) {
      res.statusCode = 404
      res.end()
    })
  }

  // error handler
  middlewares.use(errorMiddleware(server, !!middlewareMode))

  // 如果没有定义middewareMode并且有httpServer,即启用vite自身的html服务并且之前也确实定义成功了
  if (!middlewareMode && httpServer) {
    let isOptimized = false
    // overwrite listen to init optimizer before server start
    // 重写listen函数，在真正listen之前先去init optimizer初始化预构建
    const listen = httpServer.listen.bind(httpServer)
    httpServer.listen = (async (port: number, ...args: any[]) => {
      if (!isOptimized) {
        try {
          await container.buildStart({}) // 执行所有的plugin的buildStart周期
          // 依赖预构建
          server._optimizedDeps = createOptimizedDeps(server)
          isOptimized = true
        } catch (e) {
          httpServer.emit('error', e)
          return
        }
      }
      return listen(port, ...args)
    }) as any
  } else {
    // 如果没有httpServer
    await container.buildStart({})
    server._optimizedDeps = createOptimizedDeps(server)
  }

  return server
}

async function startServer(
  server: ViteDevServer,
  inlinePort?: number,
  isRestart: boolean = false
): Promise<ViteDevServer> {
  const httpServer = server.httpServer
  if (!httpServer) {
    throw new Error('Cannot call server.listen in middleware mode.')
  }

  const options = server.config.server
  const port = inlinePort ?? options.port ?? 3000
  const hostname = resolveHostname(options.host)

  const protocol = options.https ? 'https' : 'http'
  const info = server.config.logger.info
  const base = server.config.base

  const serverPort = await httpServerStart(httpServer, {
    port,
    strictPort: options.strictPort,
    host: hostname.host,
    logger: server.config.logger
  })

  // @ts-ignore
  const profileSession = global.__vite_profile_session
  if (profileSession) {
    profileSession.post('Profiler.stop', (err: any, { profile }: any) => {
      // Write profile to disk, upload, etc.
      if (!err) {
        const outPath = path.resolve('./vite-profile.cpuprofile')
        fs.writeFileSync(outPath, JSON.stringify(profile))
        info(
          colors.yellow(
            `  CPU profile written to ${colors.white(colors.dim(outPath))}\n`
          )
        )
      } else {
        throw err
      }
    })
  }

  if (options.open && !isRestart) {
    const path = typeof options.open === 'string' ? options.open : base
    openBrowser(
      path.startsWith('http')
        ? path
        : `${protocol}://${hostname.name}:${serverPort}${path}`,
      true,
      server.config.logger
    )
  }

  return server
}

function createServerCloseFn(server: http.Server | null) {
  if (!server) {
    return () => {}
  }

  let hasListened = false
  const openSockets = new Set<net.Socket>()

  server.on('connection', (socket) => {
    openSockets.add(socket)
    socket.on('close', () => {
      openSockets.delete(socket)
    })
  })

  server.once('listening', () => {
    hasListened = true
  })

  return () =>
    new Promise<void>((resolve, reject) => {
      openSockets.forEach((s) => s.destroy())
      if (hasListened) {
        server.close((err) => {
          if (err) {
            reject(err)
          } else {
            resolve()
          }
        })
      } else {
        resolve()
      }
    })
}

function resolvedAllowDir(root: string, dir: string): string {
  return normalizePath(path.resolve(root, dir))
}

export function resolveServerOptions(
  root: string,
  raw?: ServerOptions
): ResolvedServerOptions {
  const server: ResolvedServerOptions = {
    preTransformRequests: true,
    ...(raw as ResolvedServerOptions)
  }
  let allowDirs = server.fs?.allow
  const deny = server.fs?.deny || ['.env', '.env.*', '*.{crt,pem}']

  if (!allowDirs) {
    allowDirs = [searchForWorkspaceRoot(root)]
  }

  allowDirs = allowDirs.map((i) => resolvedAllowDir(root, i))

  // only push client dir when vite itself is outside-of-root
  const resolvedClientDir = resolvedAllowDir(root, CLIENT_DIR)
  if (!allowDirs.some((dir) => isParentDirectory(dir, resolvedClientDir))) {
    allowDirs.push(resolvedClientDir)
  }

  server.fs = {
    strict: server.fs?.strict ?? true,
    allow: allowDirs,
    deny
  }
  return server
}

async function restartServer(server: ViteDevServer) {
  // @ts-ignore
  global.__vite_start_time = performance.now()
  const { port: prevPort, host: prevHost } = server.config.server

  await server.close()

  let inlineConfig = server.config.inlineConfig
  if (server._forceOptimizeOnRestart) {
    inlineConfig = mergeConfig(inlineConfig, {
      server: {
        force: true
      }
    })
  }

  let newServer = null
  try {
    newServer = await createServer(inlineConfig)
  } catch (err: any) {
    server.config.logger.error(err.message, {
      timestamp: true
    })
    return
  }

  for (const key in newServer) {
    if (key === '_restartPromise') {
      // prevent new server `restart` function from calling
      // @ts-ignore
      newServer[key] = server[key]
    } else if (key !== 'app') {
      // @ts-ignore
      server[key] = newServer[key]
    }
  }

  const {
    logger,
    server: { port, host, middlewareMode }
  } = server.config
  if (!middlewareMode) {
    await server.listen(port, true)
    logger.info('server restarted.', { timestamp: true })
    if (port !== prevPort || host !== prevHost) {
      logger.info('')
      server.printUrls()
    }
  } else {
    logger.info('server restarted.', { timestamp: true })
  }

  // new server (the current server) can restart now
  newServer._restartPromise = null
}
