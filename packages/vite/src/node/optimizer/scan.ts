import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import type { ResolvedConfig, Logger } from '..'
import type { Loader, Plugin, OnLoadResult } from 'esbuild'
import { build, transform } from 'esbuild'
import {
  KNOWN_ASSET_TYPES,
  JS_TYPES_RE,
  SPECIAL_QUERY_RE,
  OPTIMIZABLE_ENTRY_RE
} from '../constants'
import {
  createDebugger,
  normalizePath,
  isObject,
  cleanUrl,
  moduleListContains,
  externalRE,
  dataUrlRE,
  multilineCommentsRE,
  singlelineCommentsRE,
  virtualModuleRE,
  virtualModulePrefix
} from '../utils'
import type { PluginContainer } from '../server/pluginContainer'
import { createPluginContainer } from '../server/pluginContainer'
import { init, parse } from 'es-module-lexer'
import MagicString from 'magic-string'
import { transformImportGlob } from '../importGlob'
import { performance } from 'perf_hooks'
import colors from 'picocolors'

const debug = createDebugger('vite:deps')

const htmlTypesRE = /\.(html|vue|svelte|astro)$/

// A simple regex to detect import sources. This is only used on
// <script lang="ts"> blocks in vue (setup only) or svelte files, since
// seemingly unused imports are dropped by esbuild when transpiling TS which
// prevents it from crawling further.
// We can't use es-module-lexer because it can't handle TS, and don't want to
// use Acorn because it's slow. Luckily this doesn't have to be bullet proof
// since even missed imports can be caught at runtime, and false positives will
// simply be ignored.
export const importsRE =
  /(?<!\/\/.*)(?<=^|;|\*\/)\s*import(?!\s+type)(?:[\w*{}\n\r\t, ]+from\s*)?\s*("[^"]+"|'[^']+')\s*(?=$|;|\/\/|\/\*)/gm

export async function scanImports(config: ResolvedConfig): Promise<{
  deps: Record<string, string>
  missing: Record<string, string>
}> {
  const start = performance.now()

  let entries: string[] = []

  // https://vitejs.dev/config/#optimizedeps-entries
  const explicitEntryPatterns = config.optimizeDeps.entries
  // https://vitejs.dev/config/#build-rollupoptions
  // 构建的时候的入口
  // 构建vite是用的rollup所有这里是rollupOptions
  const buildInput = config.build.rollupOptions?.input

  if (explicitEntryPatterns) {
    // globEntries从文件系统中找到符合explicitEntryPatterns格式的文件的绝对路径
    entries = await globEntries(explicitEntryPatterns, config)
  } else if (buildInput) {
    // 如果定义了buildInput入口，就把这个作为entry
    const resolvePath = (p: string) => path.resolve(config.root, p)
    if (typeof buildInput === 'string') {
      entries = [resolvePath(buildInput)]
    } else if (Array.isArray(buildInput)) {
      entries = buildInput.map(resolvePath)
    } else if (isObject(buildInput)) {
      entries = Object.values(buildInput).map(resolvePath)
    } else {
      throw new Error('invalid rollupOptions.input value.')
    }
  } else {
    entries = await globEntries('**/*.html', config) // 否则以html文件为entry
  }

  // Non-supported entry file types and virtual files should not be scanned for
  // dependencies.
  // 入口只能是js/ts或者是html文件
  entries = entries.filter(
    (entry) =>
      (JS_TYPES_RE.test(entry) || htmlTypesRE.test(entry)) &&
      fs.existsSync(entry)
  )

  // 如果没有entries就报错
  if (!entries.length) {
    if (!explicitEntryPatterns && !config.optimizeDeps.include) {
      config.logger.warn(
        colors.yellow(
          '(!) Could not auto-determine entry point from rollupOptions or html files ' +
            'and there are no explicit optimizeDeps.include patterns. ' +
            'Skipping dependency pre-bundling.'
        )
      )
    }
    return { deps: {}, missing: {} }
  } else {
    debug(`Crawling dependencies using entries:\n  ${entries.join('\n  ')}`)
  }

  const deps: Record<string, string> = {}
  const missing: Record<string, string> = {}
  const container = await createPluginContainer(config)
  const plugin = esbuildScanPlugin(config, container, deps, missing, entries)

  // esbuildOptions are Options to pass to esbuild during the dep scanning and optimization.
  // https://vitejs.dev/config/#optimizedeps-esbuildoptions
  const { plugins = [], ...esbuildOptions } =
    config.optimizeDeps?.esbuildOptions ?? {}

  await Promise.all(
    entries.map((entry) =>
      build({
        absWorkingDir: process.cwd(),
        write: false,
        entryPoints: [entry],
        bundle: true,
        format: 'esm',
        logLevel: 'error',
        plugins: [...plugins, plugin],
        ...esbuildOptions
      })
    )
  )

  debug(`Scan completed in ${(performance.now() - start).toFixed(2)}ms:`, deps)

  return {
    // Ensure a fixed order so hashes are stable and improve logs
    deps: orderedDependencies(deps),
    missing
  }
}

function orderedDependencies(deps: Record<string, string>) {
  const depsList = Object.entries(deps)
  // Ensure the same browserHash for the same set of dependencies
  depsList.sort((a, b) => a[0].localeCompare(b[0]))
  return Object.fromEntries(depsList)
}

// 传入一个pattern和config，返回符合要求的文件名
function globEntries(pattern: string | string[], config: ResolvedConfig) {
  // glob函数的第二个参数代表glob匹配的选项
  return glob(pattern, {
    cwd: config.root, // The current working directory in which to search.
    ignore: [
      // An array of glob patterns to exclude matches. This is an alternative way to use negative patterns.
      '**/node_modules/**',
      `**/${config.build.outDir}/**`,
      // if there aren't explicit entries, also ignore other common folders
      ...(config.optimizeDeps.entries
        ? []
        : [`**/__tests__/**`, `**/coverage/**`])
    ],
    absolute: true // Return the absolute path for entries.
  })
}

const scriptModuleRE =
  /(<script\b[^>]*type\s*=\s*(?:"module"|'module')[^>]*>)(.*?)<\/script>/gims
export const scriptRE = /(<script\b(?:\s[^>]*>|>))(.*?)<\/script>/gims
export const commentRE = /<!--.*?-->/gs
const srcRE = /\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/im
const typeRE = /\btype\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/im
const langRE = /\blang\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/im
const contextRE = /\bcontext\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s'">]+))/im

// 获取项目入口文件当中的引入的依赖
function esbuildScanPlugin(
  config: ResolvedConfig,
  container: PluginContainer,
  depImports: Record<string, string>,
  missing: Record<string, string>,
  entries: string[]
): Plugin {
  // 生成一个map,存储path+importer路径名称 => 经过了resolveId生命周期处理过的最终的模块的id
  const seen = new Map<string, string | undefined>()

  // 调用插件的resolvedId周期获得最终的被解析过后的路径
  // vite-resolve这个默认添加的插件是最后执行的有内容返回的兜底的解析路径的插件
  const resolve = async (id: string, importer?: string) => {
    const key = id + (importer && path.dirname(importer))
    if (seen.has(key)) {
      return seen.get(key)
    }
    const resolved = await container.resolveId(
      id,
      importer && normalizePath(importer),
      {
        scan: true
      }
    )
    const res = resolved?.id
    seen.set(key, res)
    return res
  }

  // https://vitejs.dev/config/#optimizedeps-include
  // 强制指令要include的包名
  const include = config.optimizeDeps?.include // By default, linked packages not inside node_modules are not pre-bundled. Use this option to force a linked package to be pre-bundled.
  const exclude = [
    ...(config.optimizeDeps?.exclude || []),
    '@vite/client',
    '@vite/env'
  ] // 排除一定不要的包名

  // 是否是被指定了可以被optimize的后缀
  const isOptimizable = (id: string) =>
    OPTIMIZABLE_ENTRY_RE.test(id) ||
    !!config.optimizeDeps.extensions?.some((ext) => id.endsWith(ext)) // https://vitejs.dev/config/#resolve-extensions

  // 只要不属于entries的文件就设置为externals，不去解析external的路径
  const externalUnlessEntry = ({ path }: { path: string }) => ({
    path,
    external: !entries.includes(path)
  })

  // 最后返回一个esbuild插件
  // 注意onResolve和onLoad回调的执行是所有的插件的onResolve和onLoad都会依次执行，但是只要有其中的一个有返回的结果就停止
  return {
    name: 'vite:dep-scan',
    setup(build) {
      const scripts: Record<string, OnLoadResult> = {}

      // external urls
      // https://esbuild.github.io/api/#external
      // 把这个标记为external从而不打包url的引入
      // https的引入标记为external
      build.onResolve({ filter: externalRE }, ({ path }) => ({
        path, // 这个path是我们想要真正被解析的path
        external: true
      }))

      // data urls
      // dataurl的也标记为external
      build.onResolve({ filter: dataUrlRE }, ({ path }) => ({
        // https://esbuild.github.io/plugins/#on-resolve-results
        path,
        external: true
      }))

      // local scripts (`<script>` in Svelte and `<script setup>` in Vue)
      // virtual modules解析的路径取消前缀然后加入script namespace
      // html中的scirpt就会被当成一个virtual module包被解析
      build.onResolve({ filter: virtualModuleRE }, ({ path }) => {
        return {
          // strip prefix to get valid filesystem path so esbuild can resolve imports in the file
          path: path.replace(virtualModulePrefix, ''),
          namespace: 'script'
        }
      })

      // A callback added using onLoad will be run for each unique path/namespace pair that has not been marked as external
      // onLoad回调再每次path 和 namespace配对成功的时候出发
      // 加载script namespace中的内容的时候直接返回存储的scripts对象中的内容
      build.onLoad({ filter: /.*/, namespace: 'script' }, ({ path }) => {
        // 返回一个OnLoadResult对象，用于定义导入的内容
        return scripts[path]
      })

      // html types: extract script contents -----------------------------------
      // 定义解析html文件的引入
      build.onResolve({ filter: htmlTypesRE }, async ({ path, importer }) => {
        // importer:This is the path of the module containing this import to be resolved.
        // 运行resolveId周期
        const resolved = await resolve(path, importer)
        if (!resolved) return
        // It is possible for the scanner to scan html types in node_modules.
        // If we can optimize this html type, skip it so it's handled by the
        // bare import resolve, and recorded as optimization dep.
        // 如果html解析过后的路径包含node_modules或者是可以优化的话就不加入html namespace，并且路径也不修改,直接去onLoad
        if (resolved.includes('node_modules') && isOptimizable(resolved)) return
        // 否则加入html namespace
        return {
          path: resolved,
          namespace: 'html'
        }
      })

      // extract scripts inside HTML-like files and treat it as a js module
      // 提取出html文件中的sctipts并且把提取出来的scripts加入到scripts中
      // 最后实际上引入的也是js文件不是html文件
      build.onLoad(
        { filter: htmlTypesRE, namespace: 'html' },
        async ({ path }) => {
          let raw = fs.readFileSync(path, 'utf-8')
          // Avoid matching the content of the comment
          raw = raw.replace(commentRE, '<!---->')
          const isHtml = path.endsWith('.html')
          const regex = isHtml ? scriptModuleRE : scriptRE
          regex.lastIndex = 0
          let js = ''
          let scriptId = 0
          let match: RegExpExecArray | null
          while ((match = regex.exec(raw))) {
            const [, openTag, content] = match
            const typeMatch = openTag.match(typeRE)
            const type =
              typeMatch && (typeMatch[1] || typeMatch[2] || typeMatch[3])
            const langMatch = openTag.match(langRE)
            const lang =
              langMatch && (langMatch[1] || langMatch[2] || langMatch[3])
            // skip type="application/ld+json" and other non-JS types
            if (
              type &&
              !(
                type.includes('javascript') ||
                type.includes('ecmascript') ||
                type === 'module'
              )
            ) {
              continue
            }
            let loader: Loader = 'js'
            if (lang === 'ts' || lang === 'tsx' || lang === 'jsx') {
              loader = lang
            }
            const srcMatch = openTag.match(srcRE)
            if (srcMatch) {
              const src = srcMatch[1] || srcMatch[2] || srcMatch[3]
              js += `import ${JSON.stringify(src)}\n`
            } else if (content.trim()) {
              // The reason why virtual modules are needed:
              // 1. There can be module scripts (`<script context="module">` in Svelte and `<script>` in Vue)
              // or local scripts (`<script>` in Svelte and `<script setup>` in Vue)
              // 2. There can be multiple module scripts in html
              // We need to handle these separately in case variable names are reused between them

              // append imports in TS to prevent esbuild from removing them
              // since they may be used in the template
              const contents =
                content +
                (loader.startsWith('ts') ? extractImportPaths(content) : '')

              const key = `${path}?id=${scriptId++}`

              if (contents.includes('import.meta.glob')) {
                scripts[key] = {
                  // transformGlob already transforms to js
                  loader: 'js',
                  contents: await transformGlob(
                    contents,
                    path,
                    config.root,
                    loader,
                    resolve,
                    config.logger
                  )
                }
              } else {
                scripts[key] = {
                  loader,
                  contents
                }
              }

              const virtualModulePath = JSON.stringify(
                virtualModulePrefix + key
              )

              const contextMatch = openTag.match(contextRE)
              const context =
                contextMatch &&
                (contextMatch[1] || contextMatch[2] || contextMatch[3])

              // Especially for Svelte files, exports in <script context="module"> means module exports,
              // exports in <script> means component props. To avoid having two same export name from the
              // star exports, we need to ignore exports in <script>
              if (path.endsWith('.svelte') && context !== 'module') {
                js += `import ${virtualModulePath}\n`
              } else {
                js += `export * from ${virtualModulePath}\n`
              }
            }
          }

          // This will trigger incorrectly if `export default` is contained
          // anywhere in a string. Svelte and Astro files can't have
          // `export default` as code so we know if it's encountered it's a
          // false positive (e.g. contained in a string)
          if (!path.endsWith('.vue') || !js.includes('export default')) {
            js += '\nexport default {}'
          }

          return {
            loader: 'js',
            contents: js
          }
        }
      )

      // bare imports: record and externalize ----------------------------------
      // import {} from 'path' 这种没有npm包的路径的解析
      build.onResolve(
        {
          // avoid matching windows volume
          filter: /^[\w@][^:]/
        },
        async ({ path: id, importer }) => {
          // 如果排除在外的包含就直接放在exclude中
          if (moduleListContains(exclude, id)) {
            return externalUnlessEntry({ path: id })
          }
          // 如果已经被放入depImports也不需要再打包
          if (depImports[id]) {
            return externalUnlessEntry({ path: id })
          }
          // 解析这个路径
          const resolved = await resolve(id, importer)
          if (resolved) {
            // 如果不是绝对路径直接external
            if (shouldExternalizeDep(resolved, id)) {
              return externalUnlessEntry({ path: id })
            }
            if (resolved.includes('node_modules') || include?.includes(id)) {
              // dependency or forced included, externalize and stop crawling
              if (isOptimizable(resolved)) {
                depImports[id] = resolved
              }
              return externalUnlessEntry({ path: id })
            } else if (isScannable(resolved)) {
              // 如果可以被扫描的话
              // 如果是html文件就把namespace设置为html
              const namespace = htmlTypesRE.test(resolved) ? 'html' : undefined
              // linked package, keep crawling
              return {
                path: path.resolve(resolved),
                namespace
              }
            } else {
              return externalUnlessEntry({ path: id })
            }
          } else {
            // 被遗漏了的包
            missing[id] = normalizePath(importer)
          }
        }
      )

      // Externalized file types -----------------------------------------------
      // these are done on raw ids using esbuild's native regex filter so it
      // should be faster than doing it in the catch-all via js
      // they are done after the bare import resolve because a package name
      // may end with these extensions

      // css & json
      // css json都不用单独打包
      build.onResolve(
        {
          filter: /\.(css|less|sass|scss|styl|stylus|pcss|postcss|json)$/
        },
        externalUnlessEntry
      )

      // known asset types
      build.onResolve(
        {
          filter: new RegExp(`\\.(${KNOWN_ASSET_TYPES.join('|')})$`)
        },
        externalUnlessEntry
      )

      // known vite query types: ?worker, ?raw
      build.onResolve({ filter: SPECIAL_QUERY_RE }, ({ path }) => ({
        path,
        external: true
      }))

      // catch all -------------------------------------------------------------

      build.onResolve(
        {
          filter: /.*/
        },
        async ({ path: id, importer }) => {
          // use vite resolver to support urls and omitted extensions
          // 对所有的文件都使用插件的resolveId周期做解析
          const resolved = await resolve(id, importer)
          if (resolved) {
            if (shouldExternalizeDep(resolved, id) || !isScannable(resolved)) {
              return externalUnlessEntry({ path: id })
            }

            const namespace = htmlTypesRE.test(resolved) ? 'html' : undefined

            return {
              path: path.resolve(cleanUrl(resolved)),
              namespace
            }
          } else {
            // resolve failed... probably unsupported type
            return externalUnlessEntry({ path: id })
          }
        }
      )

      // for jsx/tsx, we need to access the content and check for
      // presence of import.meta.glob, since it results in import relationships
      // but isn't crawled by esbuild.
      build.onLoad({ filter: JS_TYPES_RE }, ({ path: id }) => {
        let ext = path.extname(id).slice(1)
        if (ext === 'mjs') ext = 'js'

        let contents = fs.readFileSync(id, 'utf-8')
        if (ext.endsWith('x') && config.esbuild && config.esbuild.jsxInject) {
          contents = config.esbuild.jsxInject + `\n` + contents
        }

        if (contents.includes('import.meta.glob')) {
          return transformGlob(
            contents,
            id,
            config.root,
            ext as Loader,
            resolve,
            config.logger
          ).then((contents) => ({
            loader: ext as Loader,
            contents
          }))
        }
        return {
          loader: ext as Loader,
          contents
        }
      })
    }
  }
}

async function transformGlob(
  source: string,
  importer: string,
  root: string,
  loader: Loader,
  resolve: (url: string, importer?: string) => Promise<string | undefined>,
  logger: Logger
) {
  // transform the content first since es-module-lexer can't handle non-js
  if (loader !== 'js') {
    source = (await transform(source, { loader })).code
  }

  await init
  const imports = parse(source)[0]
  const s = new MagicString(source)
  for (let index = 0; index < imports.length; index++) {
    const { s: start, e: end, ss: expStart } = imports[index]
    const url = source.slice(start, end)
    if (url !== 'import.meta') continue
    if (source.slice(end, end + 5) !== '.glob') continue
    const { importsString, exp, endIndex } = await transformImportGlob(
      source,
      start,
      normalizePath(importer),
      index,
      root,
      logger,
      undefined,
      resolve
    )
    s.prepend(importsString)
    s.overwrite(expStart, endIndex, exp, { contentOnly: true })
  }
  return s.toString()
}

/**
 * when using TS + (Vue + `<script setup>`) or Svelte, imports may seem
 * unused to esbuild and dropped in the build output, which prevents
 * esbuild from crawling further.
 * the solution is to add `import 'x'` for every source to force
 * esbuild to keep crawling due to potential side effects.
 */
function extractImportPaths(code: string) {
  // empty singleline & multiline comments to avoid matching comments
  code = code
    .replace(multilineCommentsRE, '/* */')
    .replace(singlelineCommentsRE, '')

  let js = ''
  let m
  while ((m = importsRE.exec(code)) != null) {
    // This is necessary to avoid infinite loops with zero-width matches
    if (m.index === importsRE.lastIndex) {
      importsRE.lastIndex++
    }
    js += `\nimport ${m[1]}`
  }
  return js
}

function shouldExternalizeDep(resolvedId: string, rawId: string): boolean {
  // not a valid file path
  if (!path.isAbsolute(resolvedId)) {
    return true
  }
  // virtual id
  if (resolvedId === rawId || resolvedId.includes('\0')) {
    return true
  }
  return false
}

function isScannable(id: string): boolean {
  return JS_TYPES_RE.test(id) || htmlTypesRE.test(id)
}
