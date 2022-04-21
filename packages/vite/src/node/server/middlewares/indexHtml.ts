import fs from 'fs'
import path from 'path'
import MagicString from 'magic-string'
import type { AttributeNode, ElementNode, TextNode } from '@vue/compiler-dom'
import { NodeTypes } from '@vue/compiler-dom'
import type { Connect } from 'types/connect'
import type { IndexHtmlTransformHook } from '../../plugins/html'
import {
  addToHTMLProxyCache,
  applyHtmlTransforms,
  assetAttrsConfig,
  getScriptInfo,
  resolveHtmlTransforms,
  traverseHtml
} from '../../plugins/html'
import type { ResolvedConfig, ViteDevServer } from '../..'
import { send } from '../send'
import { CLIENT_PUBLIC_PATH, FS_PREFIX } from '../../constants'
import { cleanUrl, fsPathFromId, normalizePath, injectQuery } from '../../utils'
import type { ModuleGraph } from '../moduleGraph'

export function createDevHtmlTransformFn(
  server: ViteDevServer
): (url: string, html: string, originalUrl: string) => Promise<string> {
  const [preHooks, postHooks] = resolveHtmlTransforms(server.config.plugins) // 返回每一个插件在transformIndexHtml周期的回调

  return (url: string, html: string, originalUrl: string): Promise<string> => {
    return applyHtmlTransforms(html, [...preHooks, devHtmlHook, ...postHooks], {
      path: url,
      filename: getHtmlFilename(url, server),
      server,
      originalUrl
    })
  }
}

function getHtmlFilename(url: string, server: ViteDevServer) {
  if (url.startsWith(FS_PREFIX)) {
    return decodeURIComponent(fsPathFromId(url))
  } else {
    return decodeURIComponent(
      normalizePath(path.join(server.config.root, url.slice(1)))
    )
  }
}

const startsWithSingleSlashRE = /^\/(?!\/)/
const processNodeUrl = (
  node: AttributeNode,
  s: MagicString,
  config: ResolvedConfig,
  htmlPath: string,
  originalUrl?: string,
  moduleGraph?: ModuleGraph
) => {
  let url = node.value?.content || ''

  if (moduleGraph) {
    const mod = moduleGraph.urlToModuleMap.get(url)
    if (mod && mod.lastHMRTimestamp > 0) {
      url = injectQuery(url, `t=${mod.lastHMRTimestamp}`)
    }
  }
  if (startsWithSingleSlashRE.test(url)) {
    // prefix with base
    s.overwrite(
      node.value!.loc.start.offset,
      node.value!.loc.end.offset,
      `"${config.base + url.slice(1)}"`,
      { contentOnly: true }
    )
  } else if (
    url.startsWith('.') &&
    originalUrl &&
    originalUrl !== '/' &&
    htmlPath === '/index.html'
  ) {
    // #3230 if some request url (localhost:3000/a/b) return to fallback html, the relative assets
    // path will add `/a/` prefix, it will caused 404.
    // rewrite before `./index.js` -> `localhost:3000/a/index.js`.
    // rewrite after `../index.js` -> `localhost:3000/index.js`.
    s.overwrite(
      node.value!.loc.start.offset,
      node.value!.loc.end.offset,
      `"${path.posix.join(
        path.posix.relative(originalUrl, '/'),
        url.slice(1)
      )}"`,
      { contentOnly: true }
    )
  }
}
const devHtmlHook: IndexHtmlTransformHook = async (
  html,
  { path: htmlPath, filename, server, originalUrl }
) => {
  const { config, moduleGraph } = server!
  const base = config.base || '/'

  const s = new MagicString(html)
  let inlineModuleIndex = -1
  const filePath = cleanUrl(htmlPath)

  const addInlineModule = (node: ElementNode, ext: 'js' | 'css') => {
    inlineModuleIndex++

    const url = filePath.replace(normalizePath(config.root), '')

    const contentNode = node.children[0] as TextNode

    const code = contentNode.content
    const map = new MagicString(html)
      .snip(contentNode.loc.start.offset, contentNode.loc.end.offset)
      .generateMap({ hires: true })
    map.sources = [filename]
    map.file = filename

    // add HTML Proxy to Map
    addToHTMLProxyCache(config, url, inlineModuleIndex, { code, map })

    // inline js module. convert to src="proxy"
    const modulePath = `${
      config.base + htmlPath.slice(1)
    }?html-proxy&index=${inlineModuleIndex}.${ext}`

    // invalidate the module so the newly cached contents will be served
    const module = server?.moduleGraph.getModuleById(modulePath)
    if (module) {
      server?.moduleGraph.invalidateModule(module)
    }

    s.overwrite(
      node.loc.start.offset,
      node.loc.end.offset,
      `<script type="module" src="${modulePath}"></script>`,
      { contentOnly: true }
    )
  }

  await traverseHtml(html, htmlPath, (node) => {
    if (node.type !== NodeTypes.ELEMENT) {
      return
    }

    // script tags
    if (node.tag === 'script') {
      const { src, isModule } = getScriptInfo(node)

      if (src) {
        processNodeUrl(src, s, config, htmlPath, originalUrl, moduleGraph)
      } else if (isModule && node.children.length) {
        addInlineModule(node, 'js')
      }
    }

    if (node.tag === 'style' && node.children.length) {
      addInlineModule(node, 'css')
    }

    // elements with [href/src] attrs
    const assetAttrs = assetAttrsConfig[node.tag]
    if (assetAttrs) {
      for (const p of node.props) {
        if (
          p.type === NodeTypes.ATTRIBUTE &&
          p.value &&
          assetAttrs.includes(p.name)
        ) {
          processNodeUrl(p, s, config, htmlPath, originalUrl)
        }
      }
    }
  })

  html = s.toString()

  return {
    html,
    tags: [
      {
        tag: 'script',
        attrs: {
          type: 'module',
          src: path.posix.join(base, CLIENT_PUBLIC_PATH)
        },
        injectTo: 'head-prepend'
      }
    ]
  }
}

export function indexHtmlMiddleware(
  server: ViteDevServer
): Connect.NextHandleFunction {
  // Keep the named function. The name is visible in debug logs via `DEBUG=connect:dispatcher ...`
  return async function viteIndexHtmlMiddleware(req, res, next) {
    if (res.writableEnded) {
      return next()
    }

    const url = req.url && cleanUrl(req.url)
    // spa-fallback always redirects to /index.html
    if (url?.endsWith('.html') && req.headers['sec-fetch-dest'] !== 'script') {
      // 获取html文件的名称
      const filename = getHtmlFilename(url, server)
      // 如果存在这个文件的话
      if (fs.existsSync(filename)) {
        try {
          let html = fs.readFileSync(filename, 'utf-8')
          // 执行转换html的函数得到最新的html文件
          html = await server.transformIndexHtml(url, html, req.originalUrl)
          // 返回这个html文件
          return send(req, res, html, 'html', {
            headers: server.config.server.headers
          })
        } catch (e) {
          return next(e)
        }
      }
    }
    next()
  }
}
