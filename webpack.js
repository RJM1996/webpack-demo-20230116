const { SyncHook } = require('tapable') // 用于注册生命周期函数
const path = require('path')
const fs = require('fs')
// 生成 AST 语法树相关的库
const parser = require('@babel/parser')
const types = require('@babel/types')
const traverse = require('@babel/traverse').default
const generator = require('@babel/generator').default

//将\替换成/
function toUnixPath(filePath) {
  return filePath.replace(/\\/g, '/')
}
const baseDir = toUnixPath(process.cwd())
// 获取文件路径
function tryExtensions(modulePath, extensions = []) {
  if (fs.existsSync(modulePath)) {
    return modulePath
  }
  for (let i = 0; i < extensions.length; i++) {
    const filePath = modulePath + extensions[i]
    if (fs.existsSync(filePath)) {
      return filePath
    }
  }
  throw new Error(`无法找到${modulePath}`)
}
// 生成运行时代码
function getSourceCode(chunk) {
  console.log('chunk', chunk)
  // 一个立即执行函数
  return `
(()=>{
  var modules = {
    ${chunk.modules.map((module) => {
      return `
        "${module.id}": (module)=>{
          ${module._source}
        }
      `
    })}
  }

  var cache = {}
  function require(moduleId) {
    var cachedModule = cache[moduleId]
    if(cachedModule !== undefined) {
      return cachedModule.exports
    }
    var module = (cache[moduleId] = {
      exports: {}
    });
    modules[moduleId](module, module.exports, require)
    return module.exports
  }
  var exports = {};
  ${chunk.entryModule._source}
})()
`
}

class Compiler {
  constructor(options) {
    this.options = options
    this.hooks = {
      run: new SyncHook(),
      done: new SyncHook(),
    }
  }

  compile(cb) {
    const compilation = new Compilation(this.options)
    compilation.build(cb)
  }

  run(cb) {
    this.hooks.run.call()
    const onCompiled = (err, stats, fileDependencies) => {
      for (let filename in stats.assets) {
        const dirPath = this.options.output.path
        const filePath = path.join(this.options.output.path, filename)
        if (!fs.existsSync(dirPath)) {
          fs.mkdirSync(dirPath)
        }
        fs.writeFileSync(filePath, stats.assets[filename], { flag: 'w+' })
      }
      cb(err, {
        toJson: () => stats,
      })
      this.hooks.done.call()
    }
    this.compile(onCompiled)
  }
}

// 每次编译都会生成
class Compilation {
  constructor(options) {
    this.options = options
    this.modules = [] // 本次编译生成的所有模块
    this.chunks = [] // 本次编译生成的所有代码块
    this.assets = {} // 本次编译生成的资源文件
    this.fileDependencies = [] // 本次打包涉及到的文件，这里主要是为了实现watch模式下监听文件的变化，文件发生变化后会重新编译
  }

  /**
   * 编译模块
   * @param {*} name 模块所属代码块chunk的名称
   * @param {*} modulePath 模块绝对路径
   */
  buildModule(name, modulePath) {
    // 读取模块的源代码
    let sourceCode = fs.readFileSync(modulePath, 'utf8')
    const moduleId = './' + path.posix.relative(baseDir, modulePath)
    const module = {
      id: moduleId,
      names: [name], // names设计成数组是因为代表的是此模块属于哪个代码块，可能属于多个代码块
      dependencies: [],
      _source: '', // 模块源码
    }

    // 收集匹配该文件的 loader
    const loaders = []
    const { rules = [] } = this.options.module
    rules.forEach((rule) => {
      const { test } = rule
      if (modulePath.match(test)) {
        loaders.push(...rule.use)
      }
    })

    // 遍历该模块的loader数组, 自右向左对模块源码进行转换
    sourceCode = loaders.reduceRight((code, loader) => {
      return loader(code)
    }, sourceCode)
    // 经过loader转换后的代码一定是js代码,只有js代码才能编译为AST
    // 将源码编译为AST
    const ast = parser.parse(sourceCode, { sourceType: 'module' })
    traverse(ast, {
      CallExpression: (nodePath) => {
        const { node } = nodePath
        // 在 AST 中查找 require 语句, 找出依赖的模块和绝对路径
        if (node.callee.name === 'require') {
          // 获取依赖模块
          let depModuleName = node.arguments[0].value
          // 获取当前编译模块所在的目录
          let dirName = path.posix.dirname(modulePath)
          // 获取依赖模块的绝对路径
          let depModulePath = path.posix.join(dirName, depModuleName)
          // https://v4.webpack.docschina.org/configuration/resolve/#resolve-extensions
          let extensions = this.options.resolve?.extensions || ['.js']
          depModulePath = tryExtensions(depModulePath, extensions)
          this.fileDependencies.push(depModulePath)
          // 生成依赖模块的模块ID
          const depModuleId = './' + path.posix.relative(baseDir, depModulePath)
          node.arguments = [types.stringLiteral(depModuleId)]
          module.dependencies.push({ depModuleId, depModulePath })
        }
      },
    })
    // 根据 AST 生成新的源代码, 并赋值给 module._source 属性
    const { code } = generator(ast)
    module._source = code
    // 遍历依赖模块,逐个编译(递归执行 buildModule)
    module.dependencies.forEach((dep) => {
      const { depModuleId, depModulePath } = dep
      // 判断模块是否存在,无需重复打包
      const existModule = this.modules.find((module) => module.id === depModuleId)
      if (existModule) {
        existModule.names.push(name)
      } else {
        const depModule = this.buildModule(name, depModulePath)
        this.modules.push(depModule)
      }
    })

    return module
  }

  build(cb) {
    // 根据配置文件的 entry 找到打包入口
    let entry = {}
    // 需要统一单入口和多入口
    if (typeof this.options.entry === 'string') {
      entry.main = this.options.entry
    } else {
      entry = this.options.entry
    }
    for (let entryName in entry) {
      const entryFilePath = path.posix.join(baseDir, entry[entryName])
      this.fileDependencies.push(entryFilePath)
      // 得到入口模块的 module 对象, 里面保存着该模块的文件路径,依赖模块,源代码
      let entryModule = this.buildModule(entryName, entryFilePath)
      this.modules.push(entryModule)
      // 组装代码块 chunk (每个入口文件对应一个代码块chunk)
      const chunk = {
        name: entryName,
        entryModule,
        modules: this.modules.filter((module) => module.names.includes(entryName)),
      }
      this.chunks.push(chunk)
    }

    // 把每个chunk转换成文件生成到输出列表
    this.chunks.forEach((chunk) => {
      const fileName = this.options.output.filename.replace('[name]', chunk.name)
      this.assets[fileName] = getSourceCode(chunk)
    })

    // 编译成功执行回调
    cb(
      null,
      {
        chunks: this.chunks,
        modules: this.modules,
        assets: this.assets,
      },
      this.fileDependencies
    )
  }
}

function webpack(options) {
  const compiler = new Compiler(options)
  const { plugins = [] } = options
  // 执行插件方法
  for (let plugin of plugins) {
    plugin.apply(compiler)
  }
  return compiler
}

// 自定义插件
class WebpackRunPlugin {
  constructor(options) {
    this.pluginName = 'WebpackRunPlugin'
  }
  apply(compiler) {
    compiler.hooks.run.tap(this.pluginName, () => {
      console.log(this.pluginName, '开始编译')
    })
  }
}

class WebpackDonePlugin {
  constructor(options) {
    this.pluginName = 'WebpackDonePlugin'
  }
  apply(compiler) {
    compiler.hooks.done.tap(this.pluginName, () => {
      console.log(this.pluginName, '结束编译')
    })
  }
}

// 自定义loader
const loader1 = (source) => {
  return source + '//给你的代码加点注释：loader1'
}

const loader2 = (source) => {
  return source + '//给你的代码加点注释：loader2'
}

module.exports = {
  webpack,
  WebpackRunPlugin,
  WebpackDonePlugin,
  loader1,
  loader2,
}
