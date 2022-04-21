/** eslint-disable */
import { dataToEsm } from '@rollup/pluginutils'
import type { Plugin } from 'vite'
import type { IPluginOptions, IPostCssModule } from './type'

const { join, dirname } = require('path')
const postcssModules = require('postcss-modules')
const postcss = require('postcss')
const less = require('less')
// import type { Loader, Plugin as EsBuildPlugin, OnLoadResult } from 'esbuild'

// js文件匹配规则
const jsLangs = /\.(js|ts|tsx)/
// css匹配规则
const cssLangs = /\.(css|less|scss|stylus|styl)/

// 模块化css匹配规则
// const cssModuleLangs = /\.(css|less|scss|stylus|styl)/;
// css模块化后的json结构
let cssModuleJSON: undefined | string
// css模块化参数
let modulesOptions: IPostCssModule = {
  scopeBehaviour: 'local',
  localsConvention: 'camelCase'
}
// const postcssPlugins = [postcssNested()];
// 保存的css module绝对路径
const cssModulePaths = new Set()

async function compileCSS(id: string, code: string) {
  let moduleJson
  const _postcssPlugins = [
    // ...postcssPlugins,
    postcssModules({
      ...modulesOptions,
      getJSON(
        cssFileName: string,
        module: { [name: string]: string },
        outputFileName: string
      ) {
        moduleJson = module
        if (modulesOptions && typeof modulesOptions.getJSON === 'function') {
          modulesOptions.getJSON(cssFileName, module, outputFileName)
        }
      }
    })
  ]

  const lang = (id.match(cssLangs) as string[])[1]
  // eslint-disable-next-line
  const parser = lang !== 'css' ? require(`postcss-${lang}`) : undefined
  // 首先先用less处理器处理代码
  const lessProcessedCode = await less.render(code)

  const nextCode = await postcss
    .default(_postcssPlugins)
    .process(lessProcessedCode.css, {
      parser,
      to: id,
      from: id,
      map: {
        inline: false,
        annotation: false
      }
    })
    .then((res: any) => res.css)

  return {
    moduleJson,
    code: nextCode
  }
}

const pluginScan: () => Plugin = () => {
  return {
    enforce: 'pre',
    name: 'vite-plugin-collect-css-module',
    async transform(raw: string, id: string) {
      // 如果不是js文件就不需要考虑css module的使用
      if (!jsLangs.test(id)) return
      // 用一个正则表达式收集所有的css module导入
      const reg = /import.*?from.*?(?:'|")(.*?\.(?:css|less))(?:'|")/g
      let arr
      // eslint-disable-next-line
      while ((arr = reg.exec(raw)) !== null) {
        const path = arr[1]
        const absPath = join(dirname(id), path)
        cssModulePaths.add(absPath)
      }
    }
  }
}

const pluginPre: () => Plugin = () => {
  return {
    enforce: 'pre',
    name: 'vite-plugin-transform-css-modules-pre',
    async resolveId(id) {
      if (cssLangs.test(id) && cssModulePaths.has(id)) {
        return {
          id: 'index.zxh'
        }
      }
      return null
    },
    // eslint-disable-next-line
    async transform(raw: string, id: string) {
      if (cssLangs.test(id) && cssModulePaths.has(id)) {
        const { code, moduleJson } = await compileCSS(id, raw)

        // 导出模块化后的字符串给后置的插件使用
        cssModuleJSON =
          moduleJson &&
          dataToEsm(moduleJson, { namedExports: true, preferConst: true })

        return {
          code,
          map: { mappings: '' }
        }
      }
    }
  }
}

const pluginPost: () => Plugin = () => {
  let server
  return {
    enforce: 'post',
    name: 'vite-plugin-transform-css-modules-post',
    configureServer(_server) {
      server = _server
    },
    async resolveId(id) {
      if (id === 'index.zxh') {
        console.log(id)
      }
    },
    // eslint-disable-next-line
    async transform(css: string, id: string) {
      if (cssLangs.test(id) && cssModulePaths.has(id)) {
        const { moduleGraph } = server
        const thisModule = moduleGraph.getModuleById(id)
        thisModule.isSelfAccepting = false
        // TODO: 暂时用的是文字截取方案，但每个Vite版本的变量不一致，有得包含__vite__前缀有的没有，
        const startStr = 'const __vite__css = ' // 'const css = '
        const startEnd = '__vite__updateStyle(__vite__id, __vite__css)' // 'updateStyle(id, css)'

        const cssCodeStartIndex = css.indexOf(startStr)
        const cssCodeEndIndex = css.indexOf(startEnd)

        const cssStr = css.slice(
          cssCodeStartIndex + startStr.length,
          cssCodeEndIndex
        )
        const pathIdx = id.indexOf('/src/')
        const str = id.slice(pathIdx, id.length)
        const a = [
          `import.meta.hot = __vite__createHotContext('${str}');`,
          `import { updateStyle as __vite__updateStyle, removeStyle } from "/@vite/client"`,
          `const __vite__id = ${JSON.stringify(id)}`,
          `const __vite__css = ${cssStr}`,
          `__vite__updateStyle(__vite__id, __vite__css)`,
          cssModuleJSON
            ? `${cssModuleJSON}import.meta.hot.accept('${str}')`
            : 'import.meta.hot.accept();export default __vite__css;',
          `import.meta.hot.prune(() => removeStyle(__vite__id))`
        ].join('\n')
        return [
          `import { updateStyle as __vite__updateStyle, removeStyle } from "/@vite/client"`,
          `const __vite__id = ${JSON.stringify(id)}`,
          `const __vite__css = ${cssStr}`,
          `__vite__updateStyle(__vite__id, __vite__css)`,
          cssModuleJSON ? `${cssModuleJSON}` : 'export default __vite__css;',
          `import.meta.hot.prune(() => removeStyle(__vite__id))`
        ].join('\n')
      }
    }
  }
}

/**
 * 可自定义文件路径的css module
 */
const vitePluginCssModule = (options?: IPluginOptions) => {
  const { path, ...rest } = options || {}

  if (rest) {
    modulesOptions = { ...modulesOptions, ...rest }
  }

  return [pluginScan(), pluginPre(), pluginPost()]
}

export default vitePluginCssModule
